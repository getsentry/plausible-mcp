import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect, CONVERSION_RATES_MEANING, errorOf, type Harness } from "../harness.js";

let h: Harness;
beforeEach(async () => {
  h = await connect();
});
afterEach(() => h.close());

describe("get_timeseries", () => {
  it("asks Plausible for daily buckets of the default metrics and labels the rows", async () => {
    h.reply(() => [{ dimensions: ["2026-01-01"], metrics: [100, 200, 45.5, 120] }]);

    const result = await h.call("get_timeseries", { date_range: "30d" });

    expect(h.requests.map((r) => r.body)).toEqual([
      {
        site_id: "example.com",
        metrics: ["visitors", "pageviews", "bounce_rate", "visit_duration"],
        date_range: "30d",
        dimensions: ["time:day"],
      },
    ]);
    expect(result.structuredContent).toEqual({
      metrics: ["visitors", "pageviews", "bounce_rate", "visit_duration"],
      dimensions: ["time:day"],
      results: [{ dimensions: ["2026-01-01"], metrics: [100, 200, 45.5, 120] }],
    });
    expect(JSON.parse(result.content[0].text).results).toEqual(result.structuredContent.results);
  });

  it.each(["hour", "day", "week", "month"])("buckets by %s", async (granularity) => {
    await h.call("get_timeseries", { date_range: "7d", granularity });

    expect(h.requests[0].body.dimensions).toEqual([`time:${granularity}`]);
  });

  it("passes caller metrics through in order", async () => {
    h.reply(() => [{ dimensions: ["2026-01-01"], metrics: [3, 1] }]);

    const result = await h.call("get_timeseries", {
      date_range: "7d",
      metrics: ["events", "visitors"],
    });

    expect(h.requests[0].body.metrics).toEqual(["events", "visitors"]);
    expect(result.structuredContent.metrics).toEqual(["events", "visitors"]);
  });

  // Regression (5dcd2a6): Plausible stops at 10,000 rows without saying so.
  it("returns 9,999 buckets but rejects a series that reaches Plausible's 10,000-row limit", async () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ dimensions: [String(i)], metrics: [i] }));

    h.reply(() => rows(9_999));
    const under = await h.call("get_timeseries", {
      date_range: "all",
      granularity: "hour",
      metrics: ["visitors"],
    });
    expect(under.isError).toBeFalsy();
    expect(under.structuredContent.results).toHaveLength(9_999);

    h.reply(() => rows(10_000));
    const at = await h.call("get_timeseries", {
      date_range: "all",
      granularity: "hour",
      metrics: ["visitors"],
    });
    expect(at.isError).toBe(true);
    expect(errorOf(at).code).toBe("invalid_input");
  });

  it("explains that a bucket's conversion_rate divides by the whole period", async () => {
    h.reply(() => [{ dimensions: ["2026-01-01"], metrics: [4, 0.5] }]);

    const result = await h.call("get_timeseries", {
      date_range: "7d",
      goal: "Signup",
      metrics: ["visitors", "conversion_rate"],
    });

    expect(result.structuredContent.notes).toEqual([CONVERSION_RATES_MEANING]);
    expect(JSON.parse(result.content[0].text).notes).toEqual([CONVERSION_RATES_MEANING]);
  });

  it("treats an empty site_id as missing", async () => {
    const bare = await connect({ defaultSiteId: undefined });
    try {
      const result = await bare.call("get_timeseries", { site_id: "", date_range: "7d" });

      expect(errorOf(result).code).toBe("invalid_input");
      expect(bare.requests).toHaveLength(0);
    } finally {
      await bare.close();
    }
  });
});
