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
        pagination: { limit: 20, offset: 0 },
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
      expect.objectContaining({ pagination: { limit: 50, offset: 0 } })
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
});
