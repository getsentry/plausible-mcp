import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { connect, dataOf, errorOf, plausibleOk, type Harness } from "../harness.js";
import { previousPeriod } from "../../src/tools/compare-periods.js";

const PERIOD_A = "2026-01-01,2026-01-07";
const PERIOD_B = "2026-01-08,2026-01-14";

let h: Harness;
beforeEach(async () => {
  h = await connect();
});
afterEach(() => h.close());

/** Answer period_a and period_b with their own aggregate row, whatever order they arrive in. */
function replyWith(a: Array<number | null> | null, b: Array<number | null> | null) {
  h.reply((body) => {
    const metrics = body.date_range[0] === "2026-01-01" ? a : b;
    return metrics ? [{ dimensions: [], metrics }] : [];
  });
}

describe("compare_periods", () => {
  it("queries each period with the same metrics and filters", async () => {
    await h.call("compare_periods", { period_a: PERIOD_A, period_b: PERIOD_B, page: "/pricing" });

    const ranges = h.requests.map((request) => request.body.date_range);
    expect(ranges).toHaveLength(2);
    expect(ranges).toEqual(
      expect.arrayContaining([
        ["2026-01-01", "2026-01-07"],
        ["2026-01-08", "2026-01-14"],
      ]),
    );
    const [first, second] = h.requests.map(({ body }) => ({ ...body, date_range: "" }));
    expect(first).toEqual(second);
    expect(first.filters).toEqual([["is", "event:page", ["/pricing"]]]);
  });

  it("labels each period's aggregate and the change from period_a to period_b", async () => {
    replyWith([100, 200, 45, 120], [150, 180, 40, 130]);

    const result = await h.call("compare_periods", { period_a: PERIOD_A, period_b: PERIOD_B });

    expect(dataOf(result)).toEqual({
      period_a: {
        range: PERIOD_A,
        metrics: { visitors: 100, pageviews: 200, bounce_rate: 45, visit_duration: 120 },
      },
      period_b: {
        range: PERIOD_B,
        metrics: { visitors: 150, pageviews: 180, bounce_rate: 40, visit_duration: 130 },
      },
      deltas: {
        visitors: { absolute: 50, percent: 50 },
        pageviews: { absolute: -20, percent: -10 },
        bounce_rate: { absolute: -5, percent: -11.11 },
        visit_duration: { absolute: 10, percent: 8.33 },
      },
    });
    expect(JSON.parse(result.content[0].text)).toEqual(dataOf(result));
  });

  it("gives a null delta for every metric when Plausible has no rows", async () => {
    replyWith(null, null);

    const result = await h.call("compare_periods", {
      period_a: PERIOD_A,
      period_b: PERIOD_B,
      metrics: ["visitors", "pageviews"],
    });

    expect(dataOf(result)).toMatchObject({
      period_a: { metrics: {} },
      period_b: { metrics: {} },
      deltas: {
        visitors: { absolute: null, percent: null },
        pageviews: { absolute: null, percent: null },
      },
    });
  });

  // Bugbot on #96: the deltas walked only the baseline's metrics, so an empty baseline left
  // the result with no deltas even though period_b had values.
  it("gives a null delta for every metric when only the baseline has no rows", async () => {
    replyWith(null, [150, 180, 40, 130]);

    const result = await h.call("compare_periods", { period_a: PERIOD_A, period_b: PERIOD_B });

    expect(dataOf(result).period_b.metrics.visitors).toBe(150);
    expect(Object.keys(dataOf(result).deltas)).toEqual([
      "visitors",
      "pageviews",
      "bounce_rate",
      "visit_duration",
    ]);
    expect(dataOf(result).deltas.visitors).toEqual({ absolute: null, percent: null });
  });

  it("gives null deltas when only one period has rows", async () => {
    replyWith([100, 200, 45, 120], null);

    const result = await h.call("compare_periods", { period_a: PERIOD_A, period_b: PERIOD_B });

    expect(result.isError).toBeFalsy();
    expect(dataOf(result).period_b.metrics).toEqual({});
    expect(dataOf(result).deltas.visitors).toEqual({ absolute: null, percent: null });
  });

  // Plausible reports metrics to at most two decimals.
  const metric = fc.oneof(
    fc.constant(0),
    fc.integer({ min: 0, max: 100_000_000 }).map((n) => n / 100),
    fc.integer({ min: 0, max: 1_000_000 }),
  );
  const nonZero = metric.filter((value) => value !== 0);

  async function deltaFor(a: number | null, b: number | null) {
    replyWith([a], [b]);
    const result = await h.call("compare_periods", {
      period_a: PERIOD_A,
      period_b: PERIOD_B,
      metrics: ["visitors"],
    });
    const data = dataOf(result);
    expect([data.period_a.metrics.visitors, data.period_b.metrics.visitors]).toEqual([a, b]);
    return data.deltas.visitors;
  }

  it("gives an absolute change within half a cent of period_b - period_a, in whole cents", async () => {
    await fc.assert(
      fc.asyncProperty(metric, metric, async (a, b) => {
        const { absolute } = await deltaFor(a, b);
        expect(absolute).toBeCloseTo(b - a, 2);
        expect(Math.round((absolute ?? Number.NaN) * 100) / 100).toBe(absolute);
      }),
      { numRuns: 60 },
    );
  });

  it("gives the percent change relative to a nonzero period_a, within half a hundredth", async () => {
    await fc.assert(
      fc.asyncProperty(nonZero, metric, async (a, b) => {
        expect((await deltaFor(a, b)).percent).toBeCloseTo(((b - a) / a) * 100, 2);
      }),
      { numRuns: 60 },
    );
  });

  it("gives no percent change from a zero period_a", async () => {
    await fc.assert(
      fc.asyncProperty(metric, async (b) => {
        expect((await deltaFor(0, b)).percent).toBeNull();
      }),
      { numRuns: 20 },
    );
  });

  it("gives null deltas when either period's value is null", async () => {
    const side = fc.oneof(fc.constant(null), metric);
    const pair = fc.tuple(side, side).filter(([a, b]) => a === null || b === null);
    await fc.assert(
      fc.asyncProperty(pair, async ([a, b]) => {
        expect(await deltaFor(a, b)).toEqual({ absolute: null, percent: null });
      }),
      { numRuns: 20 },
    );
  });
});

// Resolved ranges as Plausible returned them for blog.sentry.io (America/Toronto).
const TODAY = "2026-11-20";

describe("previousPeriod", () => {
  it("moves whole days back by their own number of days", () => {
    expect(
      previousPeriod("7d", ["2026-11-13T00:00:00-05:00", "2026-11-19T23:59:59-05:00"], TODAY),
    ).toBe("2026-11-06,2026-11-12");
    expect(
      previousPeriod("6mo", ["2026-05-01T00:00:00-04:00", "2026-10-31T23:59:59-04:00"], TODAY),
    ).toBe("2025-10-29,2026-04-30");
  });

  it("gives any whole-day period of N days a period of N days that ends the day before it", () => {
    const day = fc
      .integer({ min: 0, max: 20_000 })
      .map((n) => new Date(Date.UTC(2000, 0, 1) + n * 86_400_000).toISOString().slice(0, 10));
    fc.assert(
      fc.property(day, fc.integer({ min: 1, max: 400 }), (start, length) => {
        const end = new Date(Date.parse(start) + (length - 1) * 86_400_000)
          .toISOString()
          .slice(0, 10);
        const [a, b] = previousPeriod(
          `${start},${end}`,
          [`${start}T00:00:00Z`, `${end}T23:59:59Z`],
          "2099-12-31",
        ).split(",");

        expect((Date.parse(b) - Date.parse(a)) / 86_400_000 + 1).toBe(length);
        expect(Date.parse(start) - Date.parse(b)).toBe(86_400_000);
      }),
    );
  });

  it("leaves out days after today, as Plausible does", () => {
    expect(
      previousPeriod("month", ["2026-11-01T00:00:00-04:00", "2026-11-30T23:59:59-05:00"], TODAY),
    ).toBe("2026-10-12,2026-10-31");
  });

  it("takes today from Plausible, not from the range's UTC offset", () => {
    // In July, Toronto is at -04:00 while both ends of "year" are at -05:00.
    expect(
      previousPeriod(
        "year",
        ["2026-01-01T00:00:00-05:00", "2026-12-31T23:59:59-05:00"],
        "2026-07-20",
      ),
    ).toBe("2025-06-14,2025-12-31");
  });

  it("moves today and hour windows back by their length in time", () => {
    expect(previousPeriod("day", ["2026-11-20T00:00:00-05:00", "2026-11-20T18:57:51-05:00"])).toBe(
      "2026-11-19T05:00:00Z,2026-11-19T23:57:51Z",
    );
    expect(previousPeriod("24h", ["2026-11-19T18:57:51-05:00", "2026-11-20T18:57:51-05:00"])).toBe(
      "2026-11-18T23:57:51Z,2026-11-19T23:57:51Z",
    );
    expect(
      previousPeriod("2026-11-13T12:00:00-05:00,2026-11-13T15:00:00-05:00", [
        "2026-11-13T12:00:00-05:00",
        "2026-11-13T15:00:00-05:00",
      ]),
    ).toBe("2026-11-13T14:00:00Z,2026-11-13T17:00:00Z");
  });

  it("asks for period_a when period_b starts after today", () => {
    expect(() =>
      previousPeriod(
        "2026-12-01,2026-12-07",
        ["2026-12-01T00:00:00-05:00", "2026-12-07T23:59:59-05:00"],
        TODAY,
      ),
    ).toThrow("Pass period_a");
  });
});

describe("compare_periods without period_a", () => {
  it("queries period_b and today, then the period right before period_b", async () => {
    h.reply((body) => {
      if (body.date_range === "day")
        return plausibleOk([], { date_range: ["2024-03-25T00:00:00Z", "2024-03-25T10:00:00Z"] });
      if (Array.isArray(body.date_range) && body.date_range[0] === "2024-03-15") {
        return plausibleOk([{ dimensions: [], metrics: [50] }], {
          date_range: ["2024-03-15T00:00:00Z", "2024-03-21T23:59:59Z"],
        });
      }
      return [{ dimensions: [], metrics: [40] }];
    });

    const result = await h.call("compare_periods", {
      period_b: "2024-03-15,2024-03-21",
      metrics: ["visitors"],
    });

    expect(h.requests.map((r) => r.body.date_range)).toEqual([
      ["2024-03-15", "2024-03-21"],
      "day",
      ["2024-03-08", "2024-03-14"],
    ]);
    expect(dataOf(result).period_a).toEqual({
      range: "2024-03-08,2024-03-14",
      metrics: { visitors: 40 },
    });
    expect(dataOf(result).deltas.visitors).toEqual({ absolute: 10, percent: 25 });
  });

  it("asks for period_a when Plausible returns no resolved dates", async () => {
    h.reply(() => plausibleOk([], { date_range: "7d" }));

    const result = await h.call("compare_periods", { period_b: "7d" });

    expect(errorOf(result).code).toBe("invalid_input");
    expect(result.content[0].text).toContain("Pass period_a");
  });
});
