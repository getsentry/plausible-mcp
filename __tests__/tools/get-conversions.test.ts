import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect, type Harness } from "../harness.js";

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

  it("adds the page dimension when breakdown_by_page is set", async () => {
    h.reply(() => [{ dimensions: ["Signup", "/pricing"], metrics: [40, 55, 4.2] }]);

    const result = await h.call("get_conversions", { date_range: "30d", breakdown_by_page: true });

    expect(h.requests[0].body.dimensions).toEqual(["event:goal", "event:page"]);
    expect(result.structuredContent.dimensions).toEqual(["event:goal", "event:page"]);
  });
});
