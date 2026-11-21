import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import {
  register,
  extractAggregateMetrics,
  computeDeltas,
  previousPeriod,
} from "../../src/tools/compare-periods.js";
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

  it("passes custom property filters to both calls", async () => {
    const handler = getToolHandler(server, "compare_periods");
    await handler({
      site_id: "example.com",
      period_a: "2024-01-01,2024-01-07",
      period_b: "2024-01-08,2024-01-14",
      property_filters: [{ property: "plan", operator: "is", values: ["pro"] }],
    });

    for (const call of client.query.mock.calls) {
      expect(call[0].filters).toEqual([["is", "event:props:plan", ["pro"]]]);
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

// Resolved ranges as Plausible returned them for blog.sentry.io (America/Toronto).
const TODAY = "2026-11-20";

describe("previousPeriod", () => {
  it("moves whole days back by their own number of days", () => {
    expect(
      previousPeriod("7d", ["2026-11-13T00:00:00-05:00", "2026-11-19T23:59:59-05:00"], TODAY)
    ).toBe("2026-11-06,2026-11-12");
    expect(
      previousPeriod("6mo", ["2026-05-01T00:00:00-04:00", "2026-10-31T23:59:59-04:00"], TODAY)
    ).toBe("2025-10-29,2026-04-30");
  });

  it("leaves out days after today, as Plausible does", () => {
    expect(
      previousPeriod("month", ["2026-11-01T00:00:00-04:00", "2026-11-30T23:59:59-05:00"], TODAY)
    ).toBe("2026-10-12,2026-10-31");
  });

  it("takes today from Plausible, not from the range's UTC offset", () => {
    // In July, Toronto is at -04:00 while both ends of "year" are at -05:00.
    expect(
      previousPeriod("year", ["2026-01-01T00:00:00-05:00", "2026-12-31T23:59:59-05:00"], "2026-07-20")
    ).toBe("2025-06-14,2025-12-31");
  });

  it("moves today and hour windows back by their length in time", () => {
    expect(
      previousPeriod("day", ["2026-11-20T00:00:00-05:00", "2026-11-20T18:57:51-05:00"])
    ).toBe("2026-11-19T05:00:00Z,2026-11-19T23:57:51Z");
    expect(
      previousPeriod("24h", ["2026-11-19T18:57:51-05:00", "2026-11-20T18:57:51-05:00"])
    ).toBe("2026-11-18T23:57:51Z,2026-11-19T23:57:51Z");
    expect(
      previousPeriod("2026-11-13T12:00:00-05:00,2026-11-13T15:00:00-05:00", [
        "2026-11-13T12:00:00-05:00",
        "2026-11-13T15:00:00-05:00",
      ])
    ).toBe("2026-11-13T14:00:00Z,2026-11-13T17:00:00Z");
  });

  it("asks for period_a when period_b starts after today", () => {
    expect(() =>
      previousPeriod(
        "2026-12-01,2026-12-07",
        ["2026-12-01T00:00:00-05:00", "2026-12-07T23:59:59-05:00"],
        TODAY
      )
    ).toThrow("Pass period_a");
  });
});

describe("compare_periods without period_a", () => {
  function setup(responseB: PlausibleResponse) {
    const client = createMockClient();
    client.query
      .mockResolvedValueOnce(responseB)
      .mockResolvedValueOnce({
        results: [],
        meta: {},
        query: { date_range: ["2024-03-25T00:00:00Z", "2024-03-25T10:00:00Z"] },
      })
      .mockResolvedValueOnce({ results: [{ dimensions: [], metrics: [40] }], meta: {}, query: {} });
    const server = new McpServer({ name: "test", version: "0.0.1" });
    register(server, client, "default.com");
    return { client, handler: getToolHandler(server, "compare_periods") };
  }

  it("queries period_b and today, then the period right before period_b", async () => {
    const { client, handler } = setup({
      results: [{ dimensions: [], metrics: [50] }],
      meta: {},
      query: { date_range: ["2024-03-15T00:00:00Z", "2024-03-21T23:59:59Z"] },
    });

    const result = await handler({ period_b: "2024-03-15,2024-03-21", metrics: ["visitors"] });

    expect(client.query.mock.calls.map(([params]) => params.date_range)).toEqual([
      "2024-03-15,2024-03-21",
      "day",
      "2024-03-08,2024-03-14",
    ]);
    expect(result.structuredContent.period_a).toEqual({
      range: "2024-03-08,2024-03-14",
      metrics: { visitors: 40 },
    });
    expect(result.structuredContent.deltas.visitors).toEqual({ absolute: 10, percent: 25 });
  });

  it("asks for period_a when Plausible returns no resolved dates", async () => {
    const { handler } = setup({ results: [], meta: {}, query: { date_range: "7d" } });

    const result = await handler({ period_b: "7d" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Pass period_a");
  });
});
