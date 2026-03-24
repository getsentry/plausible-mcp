import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { register, extractAggregateMetrics, computeDeltas } from "../../src/tools/compare-periods.js";
import { createMockClient, getToolHandler } from "./_helpers.js";
import type { PlausibleResponse } from "../../src/plausible.js";

describe("compare_periods helpers", () => {
  describe("extractAggregateMetrics", () => {
    it("extracts metrics from first result row", () => {
      const response: PlausibleResponse = {
        results: [{ dimensions: [], metrics: [100, 200, 45.5] }],
        meta: {},
        query: {},
      };
      expect(extractAggregateMetrics(response, ["visitors", "pageviews", "bounce_rate"])).toEqual({
        visitors: 100,
        pageviews: 200,
        bounce_rate: 45.5,
      });
    });

    it("returns empty object for no results", () => {
      const response: PlausibleResponse = {
        results: [],
        meta: {},
        query: {},
      };
      expect(extractAggregateMetrics(response, ["visitors"])).toEqual({});
    });
  });

  describe("computeDeltas", () => {
    it("computes absolute and percent change", () => {
      const a = { visitors: 100, pageviews: 200 };
      const b = { visitors: 150, pageviews: 180 };
      const deltas = computeDeltas(a, b);

      expect(deltas.visitors).toEqual({ absolute: 50, percent: 50 });
      expect(deltas.pageviews).toEqual({ absolute: -20, percent: -10 });
    });

    it("handles null values", () => {
      const a = { visitors: null as unknown as number };
      const b = { visitors: 100 };
      const deltas = computeDeltas(a, b);

      expect(deltas.visitors).toEqual({ absolute: null, percent: null });
    });

    it("handles zero in period_a (division by zero)", () => {
      const a = { visitors: 0 };
      const b = { visitors: 100 };
      const deltas = computeDeltas(a, b);

      expect(deltas.visitors).toEqual({ absolute: 100, percent: null });
    });

    it("rounds to 2 decimal places", () => {
      const a = { bounce_rate: 33.33 };
      const b = { bounce_rate: 50.0 };
      const deltas = computeDeltas(a, b);

      expect(deltas.bounce_rate.absolute).toBe(16.67);
      expect(deltas.bounce_rate.percent).toBeCloseTo(50.02, 1);
    });
  });
});

describe("compare_periods tool", () => {
  let server: McpServer;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.1" });
    client = createMockClient();
    register(server, client, "default.com");
  });

  it("makes two parallel API calls", async () => {
    const handler = getToolHandler(server, "compare_periods");
    await handler({
      site_id: "example.com",
      period_a: "2024-01-01,2024-01-07",
      period_b: "2024-01-08,2024-01-14",
    });

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({ date_range: "2024-01-01,2024-01-07" })
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({ date_range: "2024-01-08,2024-01-14" })
    );
  });

  it("returns comparison with deltas", async () => {
    // Override mock to return different values for each call
    client.query
      .mockResolvedValueOnce({
        results: [{ dimensions: [], metrics: [100, 200, 45, 120] }],
        meta: {},
        query: {},
      })
      .mockResolvedValueOnce({
        results: [{ dimensions: [], metrics: [150, 180, 40, 130] }],
        meta: {},
        query: {},
      });

    const handler = getToolHandler(server, "compare_periods");
    const result = await handler({
      site_id: "example.com",
      period_a: "2024-01-01,2024-01-07",
      period_b: "2024-01-08,2024-01-14",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.period_a.metrics.visitors).toBe(100);
    expect(parsed.period_b.metrics.visitors).toBe(150);
    expect(parsed.deltas.visitors.absolute).toBe(50);
    expect(parsed.deltas.visitors.percent).toBe(50);
  });

  it("passes page and goal filters to both calls", async () => {
    const handler = getToolHandler(server, "compare_periods");
    await handler({
      site_id: "example.com",
      period_a: "2024-01-01,2024-01-07",
      period_b: "2024-01-08,2024-01-14",
      page: "/pricing",
      goal: "Signup",
    });

    for (const call of client.query.mock.calls) {
      expect(call[0].filters).toEqual([
        ["is", "event:page", ["/pricing"]],
        ["is", "event:goal", ["Signup"]],
      ]);
    }
  });

  it("uses default site_id", async () => {
    const handler = getToolHandler(server, "compare_periods");
    await handler({
      period_a: "2024-01-01,2024-01-07",
      period_b: "2024-01-08,2024-01-14",
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({ site_id: "default.com" })
    );
  });
});
