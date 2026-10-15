import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer } from "../src/server.js";

// Mock fetch globally for all Plausible API calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockPlausibleOk(data?: unknown) {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve(
        data ?? {
          results: [{ dimensions: ["2024-01-15"], metrics: [500, 1200, 32.1, 95] }],
          meta: {},
          query: {},
        }
      ),
  });
}

describe("MCP Server Integration", () => {
  let client: Client;

  beforeAll(async () => {
    const server = createServer({
      apiKey: "test-key-123",
      baseUrl: "https://plausible.io",
      defaultSiteId: "example.com",
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);

    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
  });

  it("lists all 5 tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "compare_periods",
      "get_breakdown",
      "get_conversions",
      "get_sites",
      "get_timeseries",
    ]);
  });

  it("each tool has a description and input schema", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("each tool declares an output schema and read-only annotations", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.outputSchema).toBeDefined();
      expect(tool.outputSchema?.type).toBe("object");
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.idempotentHint).toBe(true);
    }
  });

  it("exposes server instructions documenting the API constraints", () => {
    const instructions = client.getInstructions();
    expect(instructions).toBeTruthy();
    expect(instructions).toContain("date_range");
    expect(instructions).toContain("Session metrics");
    expect(instructions).toContain("event:props:<name>");
  });

  it("returns structuredContent alongside the text block", async () => {
    mockPlausibleOk();

    const result = await client.callTool({
      name: "get_breakdown",
      arguments: {
        site_id: "example.com",
        date_range: "30d",
        dimension: "visit:country_name",
      },
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      metrics: string[];
      dimensions: string[];
      results: unknown[];
    };
    expect(structured.dimensions).toEqual(["visit:country_name"]);
    expect(structured.metrics).toEqual(["visitors", "pageviews", "bounce_rate"]);
    expect(Array.isArray(structured.results)).toBe(true);
  });

  it("get_timeseries returns data", async () => {
    mockPlausibleOk();

    const result = await client.callTool({
      name: "get_timeseries",
      arguments: { site_id: "example.com", date_range: "30d" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    const parsed = JSON.parse(content[0].text);
    expect(parsed.results).toBeDefined();
  });

  it("get_breakdown returns data", async () => {
    mockPlausibleOk();

    const result = await client.callTool({
      name: "get_breakdown",
      arguments: {
        site_id: "example.com",
        date_range: "30d",
        dimension: "event:page",
      },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.results).toBeDefined();
  });

  it("get_conversions returns data", async () => {
    mockPlausibleOk();

    const result = await client.callTool({
      name: "get_conversions",
      arguments: { site_id: "example.com", date_range: "30d" },
    });

    expect(result.isError).toBeFalsy();
  });

  it("compare_periods returns comparison with deltas", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            results: [{ dimensions: [], metrics: [100, 200, 45, 120] }],
            meta: {},
            query: {},
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            results: [{ dimensions: [], metrics: [150, 180, 40, 130] }],
            meta: {},
            query: {},
          }),
      });

    const result = await client.callTool({
      name: "compare_periods",
      arguments: {
        site_id: "example.com",
        period_a: "2024-01-01,2024-01-07",
        period_b: "2024-01-08,2024-01-14",
      },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.period_a).toBeDefined();
    expect(parsed.period_b).toBeDefined();
    expect(parsed.deltas).toBeDefined();
    expect(parsed.deltas.visitors.absolute).toBe(50);
  });

  it("uses default site_id when not provided", async () => {
    mockPlausibleOk();

    const result = await client.callTool({
      name: "get_timeseries",
      arguments: { date_range: "7d" },
    });

    expect(result.isError).toBeFalsy();
    // Verify the API was called with default site
    const body = JSON.parse(mockFetch.mock.lastCall[1].body);
    expect(body.site_id).toBe("example.com");
  });

  it("does not register send_feedback by default", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("send_feedback");
  });

  it("returns error when Plausible API fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Invalid API key"),
    });

    const result = await client.callTool({
      name: "get_timeseries",
      arguments: { site_id: "example.com", date_range: "7d" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain("401");
  });
});

describe("MCP Server with feedback tool enabled", () => {
  let client: Client;

  beforeAll(async () => {
    const server = createServer({
      apiKey: "test-key-123",
      defaultSiteId: "example.com",
      enableFeedbackTool: true,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
  });

  it("registers send_feedback alongside the query tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("send_feedback");
  });

  it("mentions send_feedback in the server instructions", () => {
    expect(client.getInstructions()).toContain("send_feedback");
  });

  it("records feedback and returns structured confirmation", async () => {
    const result = await client.callTool({
      name: "send_feedback",
      arguments: {
        message: "The combination-rules error message could name the offending metric",
        category: "confusing_error",
      },
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      recorded: boolean;
      feedback_id?: string;
    };
    expect(structured.recorded).toBe(true);
    // Uses the real (unmocked) Sentry withScope/captureFeedback: proves withScope
    // propagates the callback's return value, so the feedback id is not lost.
    expect(structured.feedback_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("rejects messages that are too short to act on", async () => {
    const result = await client.callTool({
      name: "send_feedback",
      arguments: { message: "bad" },
    });

    expect(result.isError).toBe(true);
  });
});

describe("MCP HTTP protocol eras", () => {
  const handler = createMcpHandler(() => createServer({
    apiKey: "test-key-123",
    defaultSiteId: "example.com",
  }));

  afterAll(async () => {
    await handler.close();
  });

  it("serves the 2026-07-28 era through server/discover", async () => {
    const methods: Array<string | null> = [];
    const transport = new StreamableHTTPClientTransport(
      new URL("https://test.local/mcp"),
      {
        fetch: (url, init) => {
          const request = new Request(url, init);
          methods.push(request.headers.get("Mcp-Method"));
          return handler.fetch(request);
        },
      },
    );
    const modernClient = new Client(
      { name: "modern-test-client", version: "0.0.1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );

    try {
      await modernClient.connect(transport);
      expect(modernClient.getProtocolEra()).toBe("modern");
      expect(methods).toContain("server/discover");

      const discover = modernClient.getDiscoverResult() as unknown as {
        ttlMs: number;
        cacheScope: string;
      };
      expect(discover.ttlMs).toBe(60 * 60 * 1000);
      expect(discover.cacheScope).toBe("public");

      const toolList = await modernClient.listTools();
      expect(methods).toContain("tools/list");
      expect((toolList as unknown as { ttlMs: number }).ttlMs)
        .toBe(60 * 60 * 1000);
      expect((toolList as unknown as { cacheScope: string }).cacheScope)
        .toBe("public");
      expect(toolList.tools.map((tool) => tool.name)).toEqual([
        "get_timeseries",
        "get_sites",
        "get_breakdown",
        "get_conversions",
        "compare_periods",
      ]);
    } finally {
      await modernClient.close();
    }
  });

  it("keeps serving legacy clients from the same handler", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL("https://test.local/mcp"),
      { fetch: (url, init) => handler.fetch(new Request(url, init)) },
    );
    const legacyClient = new Client({ name: "legacy-test-client", version: "0.0.1" });

    try {
      await legacyClient.connect(transport);
      expect(legacyClient.getProtocolEra()).toBe("legacy");
      const { tools } = await legacyClient.listTools();
      expect(tools).toHaveLength(5);
    } finally {
      await legacyClient.close();
    }
  });
});
