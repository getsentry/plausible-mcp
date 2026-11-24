/**
 * Test harness for the MCP server as a client sees it: a real `Client` over an in-memory
 * transport to `createServer`, with only the outbound `fetch` to Plausible replaced. Tests
 * assert on the two observable edges, the HTTP request Plausible receives and the tool
 * result the client receives, rather than on the tool internals in between.
 */
import { vi } from "vitest";
import { z } from "zod";
import * as Sentry from "@sentry/cloudflare";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer, type ServerConfig } from "../src/server.js";
import { queryResultOutputSchema } from "../src/schemas.js";
import { sitesSchema, metadataSchema } from "../src/tools/discovery.js";
import { advancedResult } from "../src/tools/query-stats.js";
import { groupedComparisonSchema } from "../src/tools/compare-breakdown.js";
import { comparePeriodsOutputSchema } from "../src/tools/compare-periods.js";
import type { JsonObject, JsonValue } from "../src/json.js";
import type { PlausibleQueryBody, PlausibleResult } from "../src/plausible.js";
export { CONVERSION_RATES_MEANING } from "../src/schemas.js";

export interface PlausibleRequest {
  url: string;
  authorization: string | null;
  body: PlausibleQueryBody;
}

/** Answer one Plausible request: rows for a 200, or a `Response` for anything else. */
export type PlausibleReply = (body: PlausibleQueryBody) => PlausibleResult[] | Response;

/** A 200 from Plausible. `query` is Plausible's echo of the resolved query, such as its date_range. */
export function plausibleOk(results: PlausibleResult[], query: JsonObject = {}): Response {
  return Response.json({ results, meta: {}, query });
}

export function plausibleError(status: number, body = "", headers: HeadersInit = {}) {
  return new Response(body, { status, headers });
}

/** Each tool's structuredContent, parsed with the output schema the tool declares. */
const OUTPUT_SCHEMAS = {
  get_timeseries: queryResultOutputSchema,
  get_breakdown: queryResultOutputSchema,
  get_conversions: queryResultOutputSchema,
  compare_periods: comparePeriodsOutputSchema,
  compare_breakdown: groupedComparisonSchema,
  query_stats: advancedResult,
  list_sites: sitesSchema,
  get_site_metadata: metadataSchema,
  send_feedback: z.object({ feedback_id: z.string() }),
};
export type ToolName = keyof typeof OUTPUT_SCHEMAS;
type StructuredContent<N extends ToolName> = z.infer<(typeof OUTPUT_SCHEMAS)[N]>;

const toolResultSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string() })),
  structuredContent: z.json().optional(),
});

export interface ToolResult<N extends ToolName = ToolName> {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: StructuredContent<N>;
}

export interface Harness {
  client: Client;
  /** Every request the server sent to Plausible, in order. */
  requests: PlausibleRequest[];
  /** Set how Plausible answers the following requests. */
  reply(handler: PlausibleReply): void;
  call<N extends ToolName>(name: N, args: JsonObject): Promise<ToolResult<N>>;
  close(): Promise<void>;
}

export async function connect(config: Partial<ServerConfig> = {}): Promise<Harness> {
  const requests: PlausibleRequest[] = [];
  let handler: PlausibleReply = () => [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      // The client under test sends JSON.stringify of a PlausibleQueryBody.
      const body = await request.json<PlausibleQueryBody>();
      requests.push({
        url: request.url,
        authorization: request.headers.get("Authorization"),
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
    async call<N extends ToolName>(name: N, args: JsonObject): Promise<ToolResult<N>> {
      const result = toolResultSchema.parse(await client.callTool({ name, arguments: args }));
      const { structuredContent, ...rest } = result;
      if (structuredContent === undefined) return rest;
      // SAFETY: OUTPUT_SCHEMAS[name] is the schema for tool N, so its output is N's content;
      // TypeScript only resolves the lookup to the union over every tool.
      const parsed = OUTPUT_SCHEMAS[name].parse(structuredContent) as StructuredContent<N>;
      return { ...rest, structuredContent: parsed };
    },
    async close() {
      await client.close();
      vi.unstubAllGlobals();
    },
  };
}

const toolErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    retry_after_seconds: z.number().optional(),
  }),
});

/** The structuredContent of a call that succeeded; throws with the error text otherwise. */
export function dataOf<N extends ToolName>(result: ToolResult<N>): StructuredContent<N> {
  if (result.structuredContent === undefined) {
    throw new Error(
      `Expected structuredContent, got: ${result.content.map((c) => c.text).join(" ")}`,
    );
  }
  return result.structuredContent;
}

/** The machine-readable error a failed tool call returns in its second text block. */
export function errorOf(result: ToolResult) {
  return toolErrorSchema.parse(JSON.parse(result.content[1].text)).error;
}

/** The four query tools with the smallest valid arguments for each. */
export const QUERY_TOOLS = [
  { name: "get_timeseries", args: { date_range: "30d" } },
  { name: "get_breakdown", args: { date_range: "30d", dimension: "visit:source" } },
  { name: "get_conversions", args: { date_range: "30d" } },
  {
    name: "compare_periods",
    args: { period_a: "2026-01-01,2026-01-07", period_b: "2026-01-08,2026-01-14" },
  },
] as const;

/** A span attribute as the SDK writes it: a bare value, or `{ value, type }` once serialized. */
const spanAttribute = z.union([z.object({ value: z.json() }).transform((a) => a.value), z.json()]);
const envelopeItemHeader = z.object({ type: z.string() });
const traceMetricPayload = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      value: z.number(),
      attributes: z.record(z.string(), z.object({ value: z.json() })).optional(),
    }),
  ),
});

function decodeEnvelope(body: string | Uint8Array): JsonValue[] {
  const text = body instanceof Uint8Array ? new TextDecoder().decode(body) : body;
  return text
    .split("\n")
    .filter(Boolean)
    .map((line): JsonValue => JSON.parse(line));
}

/**
 * Install a real Sentry client whose transport keeps every envelope in memory, so a test can
 * read what would leave the process. Streamed spans arrive through `beforeSendSpan`.
 */
export function captureSentry() {
  const envelopes: JsonValue[][] = [];
  const spans: JsonObject[] = [];
  const sentryClient = new Sentry.CloudflareClient({
    dsn: "https://public@example.ingest.sentry.io/1",
    tracesSampleRate: 1,
    integrations: [],
    stackParser: () => [],
    transport: (options) =>
      Sentry.createTransport(options, (request) => {
        envelopes.push(decodeEnvelope(request.body));
        return Promise.resolve({});
      }),
    beforeSendSpan: (span) => {
      spans.push(
        Object.fromEntries(
          Object.entries(span.attributes).map(([key, value]) => [key, spanAttribute.parse(value)]),
        ),
      );
      return span;
    },
  });
  Sentry.setAsyncLocalStorageAsyncContextStrategy();
  Sentry.setCurrentClient(sentryClient);
  sentryClient.init();

  /** Payloads of the given envelope item type, e.g. "feedback", parsed with `schema`. */
  function items<T>(type: string, schema: z.ZodType<T>): T[] {
    // An envelope is a header line, then item-header and payload lines in pairs.
    return envelopes.flatMap((lines) => {
      const payloads: T[] = [];
      for (let i = 1; i + 1 < lines.length; i += 2) {
        if (envelopeItemHeader.safeParse(lines[i]).data?.type === type) {
          payloads.push(schema.parse(lines[i + 1]));
        }
      }
      return payloads;
    });
  }

  return {
    envelopes,
    spans,
    items,
    /** Metrics sent, with their attribute values unwrapped and the SDK's own left out. */
    metrics() {
      return items("trace_metric", traceMetricPayload).flatMap((payload) =>
        payload.items.map(({ name, value, attributes }) => ({
          name,
          value,
          attributes: Object.fromEntries(
            Object.entries(attributes ?? {})
              .filter(([key]) => !key.startsWith("sentry."))
              .map(([key, attribute]) => [key, attribute.value]),
          ),
        })),
      );
    },
    clear() {
      envelopes.length = 0;
      spans.length = 0;
    },
    flush: () => sentryClient.flush(2000),
  };
}
