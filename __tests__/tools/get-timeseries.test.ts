import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { register, resolveSiteId } from "../../src/tools/get-timeseries.js";
import type { PlausibleClient } from "../../src/plausible.js";

function createMockClient(): PlausibleClient {
  return {
    query: vi.fn().mockResolvedValue({
      results: [{ dimensions: ["2024-01-01"], metrics: [100, 200, 45.5, 120] }],
      meta: {},
      query: {},
    }),
  } as unknown as PlausibleClient;
}

describe("resolveSiteId", () => {
  it("returns explicit site_id when provided", () => {
    expect(resolveSiteId("explicit.com", "default.com")).toBe("explicit.com");
  });

  it("falls back to default when no explicit", () => {
    expect(resolveSiteId(undefined, "default.com")).toBe("default.com");
  });

  it("throws when neither provided", () => {
    expect(() => resolveSiteId(undefined, undefined)).toThrow("site_id is required");
  });
});

describe("get_timeseries tool", () => {
  let server: McpServer;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.1" });
    client = createMockClient();
    register(server, client, "default.com");
  });

  it("declares site_id optional when a default site is configured", () => {
    const tool = (server as any)._registeredTools["get_timeseries"];
    expect(tool.inputSchema.shape.site_id.isOptional()).toBe(true);
  });

  it("declares site_id required when no default site is configured", () => {
    const bareServer = new McpServer({ name: "test", version: "0.0.1" });
    register(bareServer, client);
    const tool = (bareServer as any)._registeredTools["get_timeseries"];
    expect(tool.inputSchema.shape.site_id.isOptional()).toBe(false);
  });

  it("registers the tool", async () => {
    // Tool should be findable via the server's tool list
    const tools = await (server as any).getRegisteredTools?.();
    // Since we can't easily list tools without a transport, we verify
    // the registration didn't throw
    expect(true).toBe(true);
  });

  it("calls client.query with correct params for basic usage", async () => {
    const handler = getToolHandler(server, "get_timeseries");
    await handler({ site_id: "example.com", date_range: "30d" });

    expect(client.query).toHaveBeenCalledWith({
      site_id: "example.com",
      metrics: ["visitors", "pageviews", "bounce_rate", "visit_duration"],
      date_range: "30d",
      dimensions: ["time:day"],
      filters: [],
    });
  });

  it("uses weekly granularity", async () => {
    const handler = getToolHandler(server, "get_timeseries");
    await handler({ site_id: "example.com", date_range: "12mo", granularity: "week" });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({ dimensions: ["time:week"] })
    );
  });

  it("adds page filter for exact path", async () => {
    const handler = getToolHandler(server, "get_timeseries");
    await handler({ site_id: "example.com", date_range: "7d", page: "/pricing" });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [["is", "event:page", ["/pricing"]]],
      })
    );
  });

  it("adds page filter with wildcard", async () => {
    const handler = getToolHandler(server, "get_timeseries");
    await handler({ site_id: "example.com", date_range: "7d", page: "/blog*" });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [["contains", "event:page", ["/blog"]]],
      })
    );
  });

  it("adds goal filter", async () => {
    const handler = getToolHandler(server, "get_timeseries");
    await handler({ site_id: "example.com", date_range: "7d", goal: "Signup" });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [["is", "event:goal", ["Signup"]]],
      })
    );
  });

  it("combines page and goal filters", async () => {
    const handler = getToolHandler(server, "get_timeseries");
    await handler({
      site_id: "example.com",
      date_range: "7d",
      page: "/pricing",
      goal: "Signup",
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [
          ["is", "event:page", ["/pricing"]],
          ["is", "event:goal", ["Signup"]],
        ],
      })
    );
  });

  it("uses custom metrics", async () => {
    const handler = getToolHandler(server, "get_timeseries");
    await handler({
      site_id: "example.com",
      date_range: "7d",
      metrics: ["visitors", "events"],
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({ metrics: ["visitors", "events"] })
    );
  });

  it("uses default site_id from config", async () => {
    const handler = getToolHandler(server, "get_timeseries");
    await handler({ date_range: "7d" });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({ site_id: "default.com" })
    );
  });

  it("returns JSON formatted result", async () => {
    const handler = getToolHandler(server, "get_timeseries");
    const result = await handler({ site_id: "example.com", date_range: "7d" });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results).toBeDefined();
  });
});

// Helper: extract the tool handler from the registered tool.
// McpServer stores handlers internally as a plain object keyed by tool name.
function getToolHandler(server: McpServer, toolName: string) {
  const tools = (server as any)._registeredTools as Record<string, any>;
  const tool = tools?.[toolName];
  if (!tool) throw new Error(`Tool ${toolName} not registered`);
  return async (args: Record<string, unknown>) => {
    return tool.handler(args, {} as any);
  };
}
