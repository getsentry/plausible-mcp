import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect, CONVERSION_RATES_MEANING, plausibleOk, type Harness } from "../harness.js";

let h: Harness;
beforeEach(async () => {
  h = await connect();
});
afterEach(() => h.close());

describe("get_conversions", () => {
  it("asks Plausible for goal conversions and labels the rows", async () => {
    h.reply(() => [{ dimensions: ["Signup"], metrics: [40, 55, 4.2] }]);

    const result = await h.call("get_conversions", { date_range: "30d" });

    expect(h.requests[0].body).toMatchObject({
      metrics: ["visitors", "events", "conversion_rate"],
      dimensions: ["event:goal"],
    });
    expect(result.structuredContent).toEqual({
      metrics: ["visitors", "events", "conversion_rate"],
      dimensions: ["event:goal"],
      results: [{ dimensions: ["Signup"], metrics: [40, 55, 4.2] }],
    });
  });

  it("makes one query and adds no notes without breakdown_by_page", async () => {
    const result = await h.call("get_conversions", { date_range: "30d" });

    expect(h.requests).toHaveLength(1);
    expect(result.structuredContent).not.toHaveProperty("notes");
  });
});

// Plausible answers 0 for conversion_rate grouped by goal and page, so the tool divides each
// page's conversions by that page's visitors from a second query.
describe("get_conversions with breakdown_by_page", () => {
  beforeEach(() => {
    h.reply((body) =>
      body.dimensions.includes("event:goal")
        ? plausibleOk(
            [
              { dimensions: ["Purchase", "/pricing"], metrics: [9, 12, 0.04] },
              { dimensions: ["Purchase", "/gone"], metrics: [1, 1, 0.01] },
            ],
            { metrics: ["visitors", "events", "conversion_rate"] }
          )
        : [{ dimensions: ["/pricing"], metrics: [1150] }]
    );
  });

  it("divides each page's conversions by that page's visitors", async () => {
    const result = await h.call("get_conversions", { date_range: "30d", breakdown_by_page: true });

    expect(result.structuredContent).toMatchObject({
      metrics: ["visitors", "events", "conversion_rate", "group_conversion_rate"],
      dimensions: ["event:goal", "event:page"],
      results: [
        { dimensions: ["Purchase", "/pricing"], metrics: [9, 12, 0.04, 0.78] },
        { dimensions: ["Purchase", "/gone"], metrics: [1, 1, 0.01, null] },
      ],
      notes: [CONVERSION_RATES_MEANING],
    });
    expect(JSON.parse(result.content[0].text).query.metrics).toEqual(result.structuredContent.metrics);
  });

  it("counts page visitors without the goal and custom-property filters", async () => {
    await h.call("get_conversions", {
      date_range: "30d",
      goal: "Purchase",
      breakdown_by_page: true,
      property_filters: [
        { property: "plan", values: ["pro"] },
        { property: "visit:channel", values: ["Organic Search"] },
      ],
    });

    expect(h.requests).toHaveLength(2);
    expect(h.requests.map((r) => r.body)).toContainEqual(
      expect.objectContaining({
        metrics: ["visitors"],
        dimensions: ["event:page"],
        filters: [["is", "visit:channel", ["Organic Search"]]],
        pagination: { limit: 10_000 },
      })
    );
  });
});
