import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { register } from "../../src/tools/get-conversions.js";
import { createMockClient, getToolHandler } from "./_helpers.js";

describe("get_conversions tool", () => {
  let server: McpServer;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.1" });
    client = createMockClient();
    register(server, client, "default.com");
  });

  it("queries with event:goal dimension by default", async () => {
    const handler = getToolHandler(server, "get_conversions");
    await handler({ site_id: "example.com", date_range: "30d" });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({
        dimensions: ["event:goal"],
        metrics: ["visitors", "events", "conversion_rate"],
      })
    );
  });

  it("adds event:page dimension when breakdown_by_page is true", async () => {
    const handler = getToolHandler(server, "get_conversions");
    await handler({
      site_id: "example.com",
      date_range: "30d",
      breakdown_by_page: true,
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({
        dimensions: ["event:goal", "event:page"],
      })
    );
  });

  it("filters by specific goal", async () => {
    const handler = getToolHandler(server, "get_conversions");
    await handler({
      site_id: "example.com",
      date_range: "30d",
      goal: "Signup",
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [["is", "event:goal", ["Signup"]]],
      })
    );
  });

  it("filters by goal and page", async () => {
    const handler = getToolHandler(server, "get_conversions");
    await handler({
      site_id: "example.com",
      date_range: "30d",
      goal: "Signup",
      page: "/pricing",
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [
          ["is", "event:goal", ["Signup"]],
          ["is", "event:page", ["/pricing"]],
        ],
      })
    );
  });

  it("uses default site_id", async () => {
    const handler = getToolHandler(server, "get_conversions");
    await handler({ date_range: "7d" });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({ site_id: "default.com" })
    );
  });
});
