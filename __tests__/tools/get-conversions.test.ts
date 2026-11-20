import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { register } from "../../src/tools/get-conversions.js";
import { CONVERSION_RATES_MEANING } from "../../src/schemas.js";
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

  it("filters by a custom property", async () => {
    const handler = getToolHandler(server, "get_conversions");
    await handler({
      site_id: "example.com",
      date_range: "30d",
      goal: "Signup",
      property_filters: [{ property: "plan", operator: "is", values: ["pro"] }],
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [
          ["is", "event:goal", ["Signup"]],
          ["is", "event:props:plan", ["pro"]],
        ],
      })
    );
  });

  it("rejects combining the goal shortcut with an event:goal filter", async () => {
    const handler = getToolHandler(server, "get_conversions");
    const result = await handler({
      site_id: "example.com",
      date_range: "30d",
      goal: "Signup",
      property_filters: [
        { property: "event:goal", operator: "is", values: ["Purchase"] },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("property_filters");
    expect(client.query).not.toHaveBeenCalled();
  });

  it("uses default site_id", async () => {
    const handler = getToolHandler(server, "get_conversions");
    await handler({ date_range: "7d" });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({ site_id: "default.com" })
    );
  });

  describe("breakdown_by_page", () => {
    function mockQueries() {
      client.query.mockImplementation(async (params: { dimensions: string[] }) =>
        params.dimensions.includes("event:goal")
          ? {
              results: [
                { dimensions: ["Purchase", "/pricing"], metrics: [9, 12, 0.04] },
                { dimensions: ["Purchase", "/gone"], metrics: [1, 1, 0.01] },
              ],
              meta: {},
              query: { metrics: ["visitors", "events", "conversion_rate"] },
            }
          : { results: [{ dimensions: ["/pricing"], metrics: [1150] }], meta: {}, query: {} }
      );
    }

    it("divides each page's conversions by that page's visitors", async () => {
      mockQueries();
      const handler = getToolHandler(server, "get_conversions");
      const result = await handler({ date_range: "30d", breakdown_by_page: true });

      expect(result.structuredContent.metrics).toEqual([
        "visitors",
        "events",
        "conversion_rate",
        "group_conversion_rate",
      ]);
      expect(result.structuredContent.results).toEqual([
        { dimensions: ["Purchase", "/pricing"], metrics: [9, 12, 0.04, 0.78] },
        { dimensions: ["Purchase", "/gone"], metrics: [1, 1, 0.01, null] },
      ]);
      expect(result.structuredContent.notes).toEqual([CONVERSION_RATES_MEANING]);
      expect(JSON.parse(result.content[0].text).query.metrics).toEqual(
        result.structuredContent.metrics
      );
    });

    it("counts page visitors without the goal and custom-property filters", async () => {
      mockQueries();
      const handler = getToolHandler(server, "get_conversions");
      await handler({
        date_range: "30d",
        goal: "Purchase",
        breakdown_by_page: true,
        property_filters: [
          { property: "plan", values: ["pro"] },
          { property: "visit:channel", values: ["Organic Search"] },
        ],
      });

      expect(client.query).toHaveBeenCalledTimes(2);
      expect(client.query).toHaveBeenCalledWith(
        expect.objectContaining({
          metrics: ["visitors"],
          dimensions: ["event:page"],
          filters: [["is", "visit:channel", ["Organic Search"]]],
          pagination: { limit: 10_000 },
        })
      );
    });

    it("makes one query without breakdown_by_page", async () => {
      const handler = getToolHandler(server, "get_conversions");
      const result = await handler({ date_range: "30d" });

      expect(client.query).toHaveBeenCalledTimes(1);
      expect(result.structuredContent).not.toHaveProperty("notes");
    });
  });
});

