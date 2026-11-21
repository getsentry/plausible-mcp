import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { connect, CONVERSION_RATES_MEANING, dataOf, errorOf, type Harness } from "../harness.js";
import type { PlausibleResult } from "../../src/plausible.js";

let h: Harness;
beforeEach(async () => {
  h = await connect();
});
afterEach(() => h.close());

describe("get_breakdown", () => {
  it("asks Plausible for one dimension and labels the rows", async () => {
    h.reply(() => [{ dimensions: ["Germany"], metrics: [10, 20, 30] }]);

    const result = await h.call("get_breakdown", {
      date_range: "30d",
      dimension: "visit:country_name",
    });

    expect(h.requests[0].body).toMatchObject({
      site_id: "example.com",
      date_range: "30d",
      dimensions: ["visit:country_name"],
      metrics: ["visitors", "pageviews", "bounce_rate"],
    });
    expect(dataOf(result)).toEqual({
      metrics: ["visitors", "pageviews", "bounce_rate"],
      dimensions: ["visit:country_name"],
      results: [{ dimensions: ["Germany"], metrics: [10, 20, 30] }],
      pagination: { limit: 20, offset: 0, has_more: false },
    });
  });

  // Regressions (d399cc7, 505c703): Plausible answers 400 to these defaults otherwise.
  it.each([
    ["event:goal", ["visitors", "pageviews", "events"]],
    ["event:hostname", ["visitors", "pageviews", "events"]],
    ["event:props:plan", ["visitors", "pageviews", "events"]],
    ["visit:entry_page", ["visitors", "visits", "bounce_rate"]],
    ["visit:exit_page", ["visitors", "visits", "bounce_rate"]],
    ["event:page", ["visitors", "pageviews", "bounce_rate"]],
    // Issue #3: the human-readable geo names.
    ["visit:country_name", ["visitors", "pageviews", "bounce_rate"]],
    ["visit:region_name", ["visitors", "pageviews", "bounce_rate"]],
    ["visit:city_name", ["visitors", "pageviews", "bounce_rate"]],
  ])("defaults %s to metrics Plausible accepts with it", async (dimension, metrics) => {
    await h.call("get_breakdown", { date_range: "30d", dimension });

    expect(h.requests[0].body.metrics).toEqual(metrics);
  });

  it("passes caller metrics through and orders by the first one", async () => {
    await h.call("get_breakdown", {
      date_range: "7d",
      dimension: "event:page",
      metrics: ["pageviews", "visitors"],
    });

    expect(h.requests[0].body.metrics).toEqual(["pageviews", "visitors"]);
    expect(h.requests[0].body.order_by).toEqual([
      ["pageviews", "desc"],
      ["event:page", "asc"],
    ]);
  });

  it("does not send event:goal in order_by, which Plausible rejects", async () => {
    await h.call("get_breakdown", { date_range: "7d", dimension: "event:goal" });

    expect(h.requests[0].body.order_by).toEqual([["visitors", "desc"]]);
  });

  it("reports the page window in the text block as well as structuredContent", async () => {
    h.reply(() => rowsOf(["/a", "/b", "/c"]));

    const result = await h.call("get_breakdown", {
      date_range: "7d",
      dimension: "event:page",
      limit: 2,
      offset: 4,
    });

    expect(dataOf(result).pagination).toEqual({ limit: 2, offset: 4, has_more: true });
    const text = JSON.parse(result.content[0].text);
    expect(text.results).toEqual(dataOf(result).results);
    expect(text.pagination).toEqual(dataOf(result).pagination);
  });
});

describe("get_breakdown conversion rates", () => {
  it.each([
    [
      "the goal shortcut",
      { dimension: "visit:entry_page", goal: "Purchase" },
      ["visitors", "visits", "bounce_rate", "group_conversion_rate"],
    ],
    [
      "an event:goal property filter",
      {
        dimension: "visit:source",
        property_filters: [{ property: "event:goal", values: ["Purchase"] }],
      },
      ["visitors", "pageviews", "bounce_rate", "group_conversion_rate"],
    ],
    [
      "a goal, grouped by event:goal",
      { dimension: "event:goal", goal: "Purchase" },
      ["visitors", "pageviews", "events"],
    ],
  ])(
    "with %s, asks for the default metrics plus a per-row rate where it means something",
    async (_case, args, metrics) => {
      await h.call("get_breakdown", { date_range: "30d", ...args });

      expect(h.requests[0].body.metrics).toEqual(metrics);
    },
  );

  it("rejects group_conversion_rate grouped by event:goal, where it is always 0", async () => {
    const result = await h.call("get_breakdown", {
      date_range: "30d",
      dimension: "event:goal",
      metrics: ["visitors", "group_conversion_rate"],
    });

    expect(errorOf(result).code).toBe("invalid_input");
    expect(result.content[0].text).toContain("Use conversion_rate");
    expect(h.requests).toHaveLength(0);
  });

  it("explains conversion_rate's shared denominator in both result blocks", async () => {
    h.reply(() => [{ dimensions: ["/"], metrics: [4, 0.46] }]);

    const result = await h.call("get_breakdown", {
      date_range: "30d",
      dimension: "visit:entry_page",
      goal: "Purchase",
      metrics: ["visitors", "conversion_rate"],
    });

    expect(dataOf(result).notes).toEqual([CONVERSION_RATES_MEANING]);
    expect(JSON.parse(result.content[0].text).notes).toEqual([CONVERSION_RATES_MEANING]);
  });

  it("adds no notes when the result has no conversion_rate", async () => {
    const result = await h.call("get_breakdown", { date_range: "30d", dimension: "event:page" });

    expect(result.structuredContent).not.toHaveProperty("notes");
    expect(JSON.parse(result.content[0].text)).not.toHaveProperty("notes");
  });
});

function rowsOf(names: string[]): PlausibleResult[] {
  return names.map((name) => ({ dimensions: [name], metrics: [1, 1, 0] }));
}

/** Rows with distinct names and few distinct metric values, so ties are common. */
const dataset = fc.uniqueArray(
  fc.record({
    name: fc.stringMatching(/^\/[a-z]{1,6}$/),
    visitors: fc.integer({ min: 0, max: 3 }),
  }),
  { selector: (row) => row.name, maxLength: 30 },
);

/** Every row once, by visitors descending and then name ascending: the order the tool promises. */
function expectedOrder(rows: Array<{ name: string; visitors: number }>) {
  return [...rows]
    .sort((a, b) => b.visitors - a.visitors || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((row) => row.name);
}

async function walkPages(dimension: string, limit: number) {
  const names: string[] = [];
  const hasMore: boolean[] = [];
  for (let offset = 0; ; offset += limit) {
    const result = await h.call("get_breakdown", {
      date_range: "7d",
      dimension,
      metrics: ["visitors"],
      limit,
      offset,
    });
    const { results, pagination } = dataOf(result);
    if (pagination === undefined) throw new Error("get_breakdown returned no pagination");
    expect(pagination).toMatchObject({ limit, offset });
    names.push(...results.map((row) => String(row.dimensions[0])));
    hasMore.push(pagination.has_more);
    if (!pagination.has_more) return { names, hasMore };
  }
}

describe("get_breakdown paging", () => {
  // A Plausible stand-in that applies order_by and pagination as the Stats API does, and
  // orders rows that order_by leaves tied differently on every request.
  it("walks every row exactly once, in a stable order, for any data and page size", async () => {
    await fc.assert(
      fc.asyncProperty(dataset, fc.integer({ min: 1, max: 7 }), async (rows, limit) => {
        h.reply((body) => {
          const keyOf = (row: { name: string; visitors: number }, field: string) =>
            field === "event:page" ? row.name : row.visitors;
          const sorted = rows
            .map((row) => ({ row, tie: Math.random() }))
            .sort((a, b) => {
              for (const [field, direction] of body.order_by ?? []) {
                const [x, y] = [keyOf(a.row, field), keyOf(b.row, field)];
                if (x !== y) return (x < y ? -1 : 1) * (direction === "asc" ? 1 : -1);
              }
              return a.tie - b.tie;
            });
          const { limit: take, offset = 0 } = body.pagination ?? { limit: 10_000 };
          return sorted
            .slice(offset, offset + take)
            .map(({ row }) => ({ dimensions: [row.name], metrics: [row.visitors] }));
        });

        const { names, hasMore } = await walkPages("event:page", limit);

        expect(names).toEqual(expectedOrder(rows));
        // has_more is true on every page but the last, and the last page is not empty.
        expect(hasMore).toHaveLength(Math.max(1, Math.ceil(rows.length / limit)));
        expect(hasMore.slice(0, -1).every(Boolean)).toBe(true);
      }),
      { numRuns: 40 },
    );
  });

  // Regression (f1aebc5): Plausible cannot order goals by name, so tied goals came back in a
  // different order on each request and pages skipped or repeated them.
  it("pages goals over a stable order however Plausible orders tied rows", async () => {
    await fc.assert(
      fc.asyncProperty(
        dataset,
        fc.integer({ min: 1, max: 7 }),
        fc.integer({ min: 1, max: 2 ** 30 }),
        async (rows, limit, seed) => {
          // A small linear congruential generator, so each request gets fresh tie keys.
          let state = seed;
          const nextKey = () => (state = (state * 1_103_515_245 + 12_345) % 2 ** 31);
          h.reply((body) => {
            expect(body.pagination).toEqual({ limit: 10_000 });
            // Visitors descending, but ties shuffled differently on every request.
            const shuffled = rows
              .map((row) => ({ row, key: nextKey() }))
              .sort((a, b) => b.row.visitors - a.row.visitors || a.key - b.key)
              .map(({ row }) => row);
            return shuffled.map((row) => ({ dimensions: [row.name], metrics: [row.visitors] }));
          });

          const { names } = await walkPages("event:goal", limit);

          expect(names).toEqual(expectedOrder(rows));
        },
      ),
      { numRuns: 40 },
    );
  });
});
