/**
 * Test harness for the MCP server as a client sees it: a real `Client` over an in-memory
 * transport to `createServer`, with only the outbound `fetch` to Plausible replaced. Tests
 * assert on the two observable edges, the HTTP request Plausible receives and the tool
 * result the client receives, rather than on the tool internals in between.
 */
import { vi } from "vitest";
import * as Sentry from "@sentry/cloudflare";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer, type ServerConfig } from "../src/server.js";
import type { PlausibleResult } from "../src/plausible.js";

export interface PlausibleRequest {
  url: string;
  authorization: string | null;
  body: Record<string, any>;
}

/** Answer one Plausible request: rows for a 200, or a `Response` for anything else. */
export type PlausibleReply = (body: Record<string, any>) => PlausibleResult[] | Response;

export function plausibleOk(results: PlausibleResult[]): Response {
  return Response.json({ results, meta: {}, query: {} });
}

export function plausibleError(status: number, body = "", headers: Record<string, string> = {}) {
  return new Response(body, { status, headers });
}

export interface Harness {
  client: Client;
  /** Every request the server sent to Plausible, in order. */
  requests: PlausibleRequest[];
  /** Set how Plausible answers the following requests. */
  reply(handler: PlausibleReply): void;
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

export interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: any;
}

export async function connect(config: Partial<ServerConfig> = {}): Promise<Harness> {
  const requests: PlausibleRequest[] = [];
  let handler: PlausibleReply = () => [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("Authorization"),
        body,
      });
      const reply = handler(body);
      return reply instanceof Response ? reply : plausibleOk(reply);
    }),
  );

  const server = createServer({ apiKey: "test-key", defaultSiteId: "example.com", ...config });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);

  return {
    client,
    requests,
    reply(next) {
      handler = next;
    },
    async call(name, args) {
      return (await client.callTool({ name, arguments: args })) as ToolResult;
    },
    async close() {
      await client.close();
      vi.unstubAllGlobals();
    },
  };
}

/** The machine-readable error a failed tool call returns in its second text block. */
export function errorOf(result: ToolResult) {
  return JSON.parse(result.content[1].text).error as {
    code: string;
    message: string;
    retryable: boolean;
    retry_after_seconds?: number;
  };
}

/** The four query tools with the smallest valid arguments for each. */
export const QUERY_TOOLS = [
  { name: "get_timeseries", args: { date_range: "30d" } },
  { name: "get_breakdown", args: { date_range: "30d", dimension: "visit:source" } },
  { name: "get_conversions", args: { date_range: "30d" } },
  { name: "compare_periods", args: { period_a: "2026-01-01,2026-01-07", period_b: "2026-01-08,2026-01-14" } },
] as const;

/**
 * Install a real Sentry client whose transport keeps every envelope in memory, so a test can
 * read what would leave the process. Streamed spans arrive through `beforeSendSpan`.
 */
export function captureSentry() {
  const envelopes: Array<Array<Record<string, any>>> = [];
  const spans: Array<Record<string, unknown>> = [];
  const sentryClient = new Sentry.CloudflareClient({
    dsn: "https://public@example.ingest.sentry.io/1",
    tracesSampleRate: 1,
    integrations: [],
    stackParser: () => [],
    transport: (options) =>
      Sentry.createTransport(options, (request) => {
        const text =
          typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body);
        envelopes.push(text.split("\n").filter(Boolean).map((line) => JSON.parse(line)));
        return Promise.resolve({});
      }),
    beforeSendSpan: (span) => {
      spans.push(
        Object.fromEntries(
          Object.entries(span.attributes ?? {}).map(([key, attribute]) => [
            key,
            (attribute as { value?: unknown })?.value ?? attribute,
          ]),
        ),
      );
      return span;
    },
  });
  Sentry.setAsyncLocalStorageAsyncContextStrategy();
  Sentry.setCurrentClient(sentryClient);
  sentryClient.init();
  return {
    envelopes,
    spans,
    /** Event payloads of the given envelope item type, e.g. "feedback". */
    items(type: string) {
      // An envelope is a header line, then item-header and payload lines in pairs.
      return envelopes.flatMap((lines) => {
        const payloads = [];
        for (let i = 1; i + 1 < lines.length; i += 2) {
          if (lines[i].type === type) payloads.push(lines[i + 1]);
        }
        return payloads;
      });
    },
    flush: () => sentryClient.flush(2000),
  };
}
