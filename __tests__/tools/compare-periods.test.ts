import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { connect, type Harness } from "../harness.js";

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

    const ranges = h.requests.map((request) => request.body.date_range).sort();
    expect(ranges).toEqual([
      ["2026-01-01", "2026-01-07"],
      ["2026-01-08", "2026-01-14"],
    ]);
    const [first, second] = h.requests.map(({ body: { date_range, ...rest } }) => rest);
    expect(first).toEqual(second);
    expect(first.filters).toEqual([["is", "event:page", ["/pricing"]]]);
  });

  it("labels each period's aggregate and the change from period_a to period_b", async () => {
    replyWith([100, 200, 45, 120], [150, 180, 40, 130]);

    const result = await h.call("compare_periods", { period_a: PERIOD_A, period_b: PERIOD_B });

    expect(result.structuredContent).toEqual({
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
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });

  it("returns empty metrics and deltas when Plausible has no rows", async () => {
    replyWith(null, null);

    const result = await h.call("compare_periods", { period_a: PERIOD_A, period_b: PERIOD_B });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      period_a: { metrics: {} },
      period_b: { metrics: {} },
      deltas: {},
    });
  });

  it("computes each delta from period_a to period_b, rounded to cents", async () => {
    const value = fc.oneof(
      { weight: 1, arbitrary: fc.constant(null) },
      { weight: 1, arbitrary: fc.constant(0) },
      // Plausible reports metrics to at most two decimals.
      { weight: 3, arbitrary: fc.integer({ min: 0, max: 100_000_000 }).map((n) => n / 100) },
      { weight: 3, arbitrary: fc.integer({ min: 0, max: 1_000_000 }) },
    );
    await fc.assert(
      fc.asyncProperty(value, value, async (a, b) => {
        replyWith([a], [b]);

        const result = await h.call("compare_periods", {
          period_a: PERIOD_A,
          period_b: PERIOD_B,
          metrics: ["visitors"],
        });
        const { absolute, percent } = result.structuredContent.deltas.visitors;

        expect(result.structuredContent.period_a.metrics.visitors).toBe(a);
        expect(result.structuredContent.period_b.metrics.visitors).toBe(b);
        if (a === null || b === null) {
          expect({ absolute, percent }).toEqual({ absolute: null, percent: null });
          return;
        }
        const cents = (x: number) => Math.abs(x * 100 - Math.round(x * 100));
        expect(Math.abs(absolute - (b - a))).toBeLessThanOrEqual(0.005 + 1e-9);
        expect(cents(absolute)).toBeLessThan(1e-6);
        if (a === 0) {
          expect(percent).toBeNull();
        } else {
          const exact = ((b - a) / a) * 100;
          expect(Math.abs(percent - exact)).toBeLessThanOrEqual(0.005 + Math.abs(exact) * 1e-12);
          if (Math.abs(percent) >= 0.01) expect(Math.sign(percent)).toBe(Math.sign((b - a) / a));
        }
      }),
      { numRuns: 100 },
    );
  });
});
