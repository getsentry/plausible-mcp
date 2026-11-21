import { readFileSync } from "node:fs";
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer } from "../src/server.js";
import { connect, plausibleError, QUERY_TOOLS, type Harness } from "./harness.js";

describe("MCP server", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await connect();
  });
  afterAll(() => h.close());

  it("lists the four query tools and no others", async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "compare_periods",
      "get_breakdown",
      "get_conversions",
      "get_timeseries",
    ]);
  });

  it("declares an output schema and read-only, idempotent annotations on each tool", async () => {
    const { tools } = await h.client.listTools();
    for (const tool of tools) {
      expect(tool.outputSchema?.type, tool.name).toBe("object");
      expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    }
  });

  // Regression (42e1b20): serverInfo.version once stayed behind the released package.
  it("reports the package version as its serverInfo version", () => {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(h.client.getServerVersion()?.version).toBe(version);
  });

  // Regression (f9bc0e8): a misspelled argument was silently dropped.
  it.each(QUERY_TOOLS)("$name rejects an argument it does not know, without a Plausible request", async ({ name, args }) => {
    h.requests.length = 0;
    const result = await h.call(name, { ...args, goals: "Signup" });

    expect(result.isError).toBe(true);
    expect(result.content.map((block) => block.text).join("\n")).toContain("goals");
    expect(h.requests).toHaveLength(0);
  });

  it("declares in each input schema that other arguments are not allowed", async () => {
    const { tools } = await h.client.listTools();
    for (const tool of tools) expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
  });
});

describe("MCP server with the feedback tool enabled", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await connect({ enableFeedbackTool: true });
  });
  afterAll(() => h.close());

  it("registers send_feedback alongside the query tools", async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name)).toContain("send_feedback");
  });

  it("points a rejected query at send_feedback", async () => {
    h.reply(() => plausibleError(400, JSON.stringify({ error: "Invalid metric" })));

    const result = await h.call("get_timeseries", { date_range: "7d" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("send_feedback");
  });

  it("rejects a send_feedback argument it does not know", async () => {
    const result = await h.call("send_feedback", {
      task: "Break down revenue by plan",
      kind: "confusing",
      impact: "friction",
      description: "The combination-rules error message could name the offending metric",
      severity: "high",
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

  // Legacy clients through the same handler: worker.test.ts
  // "serves modern and legacy clients from the BYOK endpoint".
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
      expect(discover).toMatchObject({ capabilities: { extensions: { "io.modelcontextprotocol/ui": {} } } });
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
        "get_breakdown",
        "get_conversions",
        "compare_periods",
      ]);
    } finally {
      await modernClient.close();
    }
  });
});
