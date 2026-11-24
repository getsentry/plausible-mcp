import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connect, dataOf, type Harness, captureSentry } from "../harness.js";
import { z } from "zod";

let h: Harness;
beforeEach(async () => {
  h = await connect();
});
afterEach(() => h.close());

const ranges = { period_a: "2026-11-01,2026-11-07", period_b: "2026-11-08,2026-11-14" };
const money = { value: 125, currency: "USD", short: "$125", long: "$125.00" };

// PLAUSIBLE-MCP-W: the upstream returned 200 and the MCP SDK rejected each money cell.
it("returns purchase revenue by source intact through the MCP client", async () => {
  h.reply(() => [{ dimensions: ["newsletter"], metrics: [10, 12, money] }]);
  const report = dataOf(
    await h.call("get_breakdown", {
      date_range: "30d",
      dimension: "visit:utm_source",
      goal: "Purchase",
      metrics: ["visitors", "events", "total_revenue"],
    }),
  );
  expect(report.results[0].metrics).toEqual([10, 12, money]);
});

it("compares like currencies and explains unavailable amounts", async () => {
  h.reply((body) =>
    Response.json({
      results: [
        {
          dimensions: [],
          metrics: [body.date_range[0] === "2026-11-01" ? money : { ...money, value: 150 }],
        },
      ],
      meta: {},
      query: {},
    }),
  );
  const args = { ...ranges, metrics: ["total_revenue"], goal: "Purchase" };
  expect(dataOf(await h.call("compare_periods", args)).deltas.total_revenue).toEqual({
    absolute: 25,
    percent: 20,
  });
  h.reply((body) => [
    {
      dimensions: [],
      metrics: [body.date_range[0] === "2026-11-01" ? money : { ...money, currency: "EUR" }],
    },
  ]);
  expect(dataOf(await h.call("compare_periods", args)).deltas.total_revenue.absolute).toBeNull();
  h.reply(() =>
    Response.json({
      results: [{ dimensions: [], metrics: [null] }],
      meta: { metric_warnings: { total_revenue: { warning: "No matching revenue goal" } } },
      query: {},
    }),
  );
  expect(dataOf(await h.call("compare_periods", args)).notes).toContain(
    "total_revenue: No matching revenue goal",
  );
});

it("ranks disappearing and newly active pages across both periods", async () => {
  h.reply((body) =>
    body.date_range[0] === "2026-11-01"
      ? [
          { dimensions: ["/gone"], metrics: [12] },
          { dimensions: ["/same"], metrics: [40] },
        ]
      : [
          { dimensions: ["/new"], metrics: [20] },
          { dimensions: ["/same"], metrics: [42] },
        ],
  );
  const result = dataOf(
    await h.call("compare_breakdown", { ...ranges, dimension: "event:page", direction: "losses" }),
  );
  expect(result.groups_compared).toBe(3);
  expect(result.results).toEqual([{ group: "/gone", before: 12, after: 0, change: -12 }]);
  expect(h.requests).toHaveLength(2);
});

it("executes a native two-dimensional AI referral query with one bounded read and links the caller span", async () => {
  const telemetry = captureSentry();
  const parent = "12".repeat(16),
    spanId = "ab".repeat(8);
  const args = {
    metrics: ["visits"],
    date_range: "30d",
    dimensions: ["visit:source", "visit:entry_page"],
    filters: [["is", "visit:channel", ["AI Assistants"]]],
    include: { total_rows: true },
  };
  h.reply(() =>
    Response.json({
      results: [
        { dimensions: ["ChatGPT", "/docs"], metrics: [2] },
        { dimensions: ["Claude", "/about"], metrics: [1] },
      ],
      meta: { total_rows: 2 },
      query: {},
    }),
  );
  const result = await h.client.callTool({
    name: "query_stats",
    arguments: { ...args, pagination: { limit: 1 } },
    _meta: { traceparent: "00-" + parent + "-" + spanId + "-01" },
  });
  expect(result.structuredContent).toMatchObject({
    results: [{ dimensions: ["ChatGPT", "/docs"], metrics: [2] }],
    meta: { total_rows: 2 },
    pagination: { limit: 1, offset: 0, has_more: true },
  });
  expect(h.requests.map((r) => r.body)).toEqual([
    { ...args, site_id: "example.com", pagination: { limit: 2, offset: 0 } },
  ]);
  await telemetry.flush();
  const spans = telemetry
    .items(
      "span",
      z.object({
        items: z.array(
          z.object({
            name: z.string(),
            links: z.array(z.object({ trace_id: z.string(), span_id: z.string() })).optional(),
          }),
        ),
      }),
    )
    .flatMap((e) => e.items);
  expect(spans.find((s) => s.name.includes("query_stats"))?.links).toContainEqual({
    trace_id: parent,
    span_id: spanId,
  });
});

it("uses configured names and forwards only the caller's cursor to the catalog", async () => {
  const fetcher = vi.fn<(url: string) => Promise<Response>>((url) => {
    const endpoint = new URL(url);
    if (endpoint.pathname.endsWith("/goals"))
      return Promise.resolve(
        Response.json({
          goals: [{ display_name: "Purchase", goal_type: "event", id: "private" }],
          meta: { after: null },
        }),
      );
    if (endpoint.pathname.endsWith("/custom-props"))
      return Promise.resolve(Response.json({ custom_properties: [{ property: "plan" }] }));
    return Promise.resolve(
      Response.json({
        sites: [{ domain: "example.com", timezone: "UTC" }],
        meta: { after: "next" },
      }),
    );
  });
  vi.stubGlobal("fetch", fetcher);
  expect(dataOf(await h.call("list_sites", { after: "page-2" })).meta.after).toBe("next");
  expect(dataOf(await h.call("get_site_metadata", { kind: "goals" })).goals).toEqual([
    { display_name: "Purchase", goal_type: "event" },
  ]);
  expect(
    dataOf(await h.call("get_site_metadata", { kind: "custom_properties" })).custom_properties,
  ).toEqual([{ property: "plan" }]);
  const urls = fetcher.mock.calls.map(([url]) => new URL(url));
  expect(urls.map((u) => u.pathname)).toEqual([
    "/api/v1/sites",
    "/api/v1/sites/goals",
    "/api/v1/sites/custom-props",
  ]);
  expect(urls[0].searchParams.get("after")).toBe("page-2");
  expect(urls[1].searchParams.get("site_id")).toBe("example.com");
});
