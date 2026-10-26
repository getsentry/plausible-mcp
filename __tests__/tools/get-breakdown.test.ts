import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
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
        pagination: { limit: 21, offset: 0 },
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
      expect.objectContaining({ pagination: { limit: 51, offset: 0 } })
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

  it("accepts human-readable geo dimensions (issue #3)", async () => {
    const handler = getToolHandler(server, "get_breakdown");
    for (const dimension of [
      "visit:country_name",
      "visit:region_name",
      "visit:city_name",
    ]) {
      const result = await handler({
        site_id: "example.com",
        date_range: "30d",
        dimension,
      });
      expect(result.isError).toBeFalsy();
      expect(client.query).toHaveBeenCalledWith(
        expect.objectContaining({ dimensions: [dimension] })
      );
    }
  });

  it("breaks down by a custom property dimension", async () => {
    const handler = getToolHandler(server, "get_breakdown");
    const result = await handler({
      site_id: "example.com",
      date_range: "30d",
      dimension: "event:props:destination_host",
    });

    expect(result.isError).toBeFalsy();
    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({
        dimensions: ["event:props:destination_host"],
        metrics: ["visitors", "pageviews", "events"],
      })
    );
  });

  it.each([
    ["event:goal", ["visitors", "pageviews", "events"]],
    ["event:hostname", ["visitors", "pageviews", "events"]],
    ["visit:entry_page", ["visitors", "visits", "bounce_rate"]],
    ["visit:exit_page", ["visitors", "visits", "bounce_rate"]],
  ])("defaults %s to metrics Plausible accepts with it", async (dimension, metrics) => {
    const handler = getToolHandler(server, "get_breakdown");
    await handler({ site_id: "example.com", date_range: "30d", dimension });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({ dimensions: [dimension], metrics })
    );
  });

  it("adds custom property filters", async () => {
    const handler = getToolHandler(server, "get_breakdown");
    await handler({
      site_id: "example.com",
      date_range: "7d",
      dimension: "event:page",
      property_filters: [{ property: "plan", operator: "is", values: ["pro"] }],
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [["is", "event:props:plan", ["pro"]]],
      })
    );
  });

  it("filters by a visit-level dimension while breaking down by another dimension", async () => {
    const handler = getToolHandler(server, "get_breakdown");
    const result = await handler({
      site_id: "example.com",
      date_range: "7d",
      dimension: "event:page",
      property_filters: [
        { property: "visit:channel", operator: "is", values: ["Organic Search"] },
      ],
    });

    expect(result.isError).toBeFalsy();
    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({
        dimensions: ["event:page"],
        filters: [["is", "visit:channel", ["Organic Search"]]],
      })
    );
  });

  it("rejects combining the page shortcut with an event:page filter", async () => {
    const handler = getToolHandler(server, "get_breakdown");
    const result = await handler({
      site_id: "example.com",
      date_range: "7d",
      dimension: "visit:source",
      page: "/pricing",
      property_filters: [
        { property: "event:page", operator: "is", values: ["/docs"] },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("property_filters");
    expect(client.query).not.toHaveBeenCalled();
  });

  it("combines page and custom property filters", async () => {
    const handler = getToolHandler(server, "get_breakdown");
    await handler({
      site_id: "example.com",
      date_range: "7d",
      dimension: "event:props:destination_host",
      page: "/pricing",
      property_filters: [{ property: "ctry", operator: "is", values: ["US"] }],
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [
          ["is", "event:page", ["/pricing"]],
          ["is", "event:props:ctry", ["US"]],
        ],
      })
    );
  });

  it("returns structuredContent labelled with the metric and dimension keys", async () => {
    const handler = getToolHandler(server, "get_breakdown");
    const result = await handler({
      site_id: "example.com",
      date_range: "7d",
      dimension: "visit:source",
      metrics: ["visitors"],
    });

    expect(result.structuredContent).toMatchObject({
      metrics: ["visitors"],
      dimensions: ["visit:source"],
    });
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

  it("passes offset through to the query", async () => {
    const handler = getToolHandler(server, "get_breakdown");
    await handler({
      site_id: "example.com",
      date_range: "7d",
      dimension: "event:page",
      limit: 10,
      offset: 30,
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({ pagination: { limit: 11, offset: 30 } })
    );
  });

  it("orders by the first metric with the dimension as a tiebreaker", async () => {
    const handler = getToolHandler(server, "get_breakdown");
    await handler({
      site_id: "example.com",
      date_range: "7d",
      dimension: "event:page",
      metrics: ["pageviews", "visitors"],
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({
        order_by: [
          ["pageviews", "desc"],
          ["event:page", "asc"],
        ],
      })
    );
  });

  it("omits the dimension tiebreaker for event:goal, which Plausible rejects in order_by", async () => {
    const handler = getToolHandler(server, "get_breakdown");
    await handler({ site_id: "example.com", date_range: "7d", dimension: "event:goal" });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({ order_by: [["visitors", "desc"]] })
    );
  });

  describe("paging", () => {
    function rows(n: number) {
      return Array.from({ length: n }, (_, i) => ({
        dimensions: [`/page-${i}`],
        metrics: [i, i, 0],
      }));
    }

    it("trims the extra row and reports has_more when another page exists", async () => {
      client.query.mockResolvedValue({ results: rows(3), meta: {}, query: {} });
      const handler = getToolHandler(server, "get_breakdown");
      const result = await handler({
        site_id: "example.com",
        date_range: "7d",
        dimension: "event:page",
        limit: 2,
        offset: 4,
      });

      expect(result.structuredContent.results).toHaveLength(2);
      expect(result.structuredContent.pagination).toEqual({
        limit: 2,
        offset: 4,
        has_more: true,
      });
      const text = JSON.parse(result.content[0].text);
      expect(text.results).toHaveLength(2);
      expect(text.pagination).toEqual(result.structuredContent.pagination);
    });

    it("pages goals over a stable order however Plausible orders tied rows", async () => {
      const goal = (name: string, visitors: number) => ({
        dimensions: [name],
        metrics: [visitors, 0, 0],
      });
      const handler = getToolHandler(server, "get_breakdown");
      const pageOf = async (results: unknown[], offset: number) => {
        client.query.mockResolvedValueOnce({ results, meta: {}, query: {} });
        const result = await handler({
          site_id: "example.com",
          date_range: "2026-10-01,2026-10-07",
          dimension: "event:goal",
          limit: 2,
          offset,
        });
        return result.structuredContent;
      };

      const first = await pageOf([goal("Top", 9), goal("B", 5), goal("A", 5), goal("C", 5)], 0);
      const second = await pageOf([goal("Top", 9), goal("C", 5), goal("A", 5), goal("B", 5)], 2);

      expect(client.query).toHaveBeenCalledWith(
        expect.objectContaining({ pagination: { limit: 10_000 } })
      );
      expect([...first.results, ...second.results].map((r: any) => r.dimensions[0])).toEqual([
        "Top",
        "A",
        "B",
        "C",
      ]);
      expect(first.pagination.has_more).toBe(true);
      expect(second.pagination.has_more).toBe(false);
    });

    it("reports has_more false when the page is not full beyond limit", async () => {
      client.query.mockResolvedValue({ results: rows(2), meta: {}, query: {} });
      const handler = getToolHandler(server, "get_breakdown");
      const result = await handler({
        site_id: "example.com",
        date_range: "7d",
        dimension: "event:page",
        limit: 2,
      });

      expect(result.structuredContent.results).toHaveLength(2);
      expect(result.structuredContent.pagination).toEqual({
        limit: 2,
        offset: 0,
        has_more: false,
      });
      expect(JSON.parse(result.content[0].text).pagination).toEqual(
        result.structuredContent.pagination
      );
    });
  });
});
