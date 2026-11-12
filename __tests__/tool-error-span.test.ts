import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/cloudflare";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../src/server.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("failed tool call span, as Sentry exports it", () => {
  const spans: Array<Record<string, unknown>> = [];
  let client: Client;

  beforeAll(async () => {
    const sentryClient = new Sentry.CloudflareClient({
      dsn: "https://public@example.ingest.sentry.io/1",
      tracesSampleRate: 1,
      integrations: [],
      stackParser: () => [],
      transport: (options) => Sentry.createTransport(options, () => Promise.resolve({})),
      beforeSendSpan: (span) => {
        spans.push(Object.fromEntries(
          Object.entries(span.attributes ?? {}).map(([key, attribute]) => [
            key,
            (attribute as { value?: unknown })?.value ?? attribute,
          ]),
        ));
        return span;
      },
    });
    Sentry.setAsyncLocalStorageAsyncContextStrategy();
    Sentry.setCurrentClient(sentryClient);
    sentryClient.init();

    const server = createServer({ apiKey: "test-key", defaultSiteId: "example.com" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
  });

  it("keeps the error code that the client receives", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers(),
      text: () => Promise.resolve("Too many requests"),
    });

    const result = await client.callTool({ name: "get_timeseries", arguments: { date_range: "7d" } });
    expect(result.isError).toBe(true);

    await vi.waitFor(() =>
      expect(spans.find((data) => data["mcp.tool.name"] === "get_timeseries")).toBeDefined(),
    );
    const span = spans.find((data) => data["mcp.tool.name"] === "get_timeseries");
    expect(span).toMatchObject({
      "mcp.tool.result.is_error": true,
      "app.tool.error.code": "rate_limited",
    });
  });
});
