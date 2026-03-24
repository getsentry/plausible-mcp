import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { register } from "../../src/tools/get-breakdown.js";
import { createMockClient, getToolHandler } from "./_helpers.js";

describe("get_breakdown tool", () => {
  let server: McpServer;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.1" });
    client = createMockClient();
    register(server, client, "default.com");
  });

  it("calls client.query with correct dimension", async () => {
    const handler = getToolHandler(server, "get_breakdown");
    await handler({
      site_id: "example.com",
      date_range: "30d",
      dimension: "event:page",
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({
        site_id: "example.com",
        dimensions: ["event:page"],
        metrics: ["visitors", "pageviews", "bounce_rate"],
        pagination: { limit: 20 },
      })
    );
  });

  it("uses custom limit", async () => {
    const handler = getToolHandler(server, "get_breakdown");
    await handler({
      site_id: "example.com",
      date_range: "7d",
      dimension: "visit:source",
      limit: 50,
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({ pagination: { limit: 50 } })
    );
  });

  it("adds page filter", async () => {
    const handler = getToolHandler(server, "get_breakdown");
    await handler({
      site_id: "example.com",
      date_range: "7d",
      dimension: "visit:country",
      page: "/pricing",
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [["is", "event:page", ["/pricing"]]],
      })
    );
  });

  it("uses default site_id", async () => {
    const handler = getToolHandler(server, "get_breakdown");
    await handler({ date_range: "7d", dimension: "event:page" });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({ site_id: "default.com" })
    );
  });

  it("uses custom metrics", async () => {
    const handler = getToolHandler(server, "get_breakdown");
    await handler({
      site_id: "example.com",
      date_range: "7d",
      dimension: "event:page",
      metrics: ["visitors", "visit_duration"],
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({ metrics: ["visitors", "visit_duration"] })
    );
  });
});
