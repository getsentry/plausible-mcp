import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { register as timeseries } from "../src/tools/get-timeseries.js";
import { register as breakdown } from "../src/tools/get-breakdown.js";
import { register as conversions } from "../src/tools/get-conversions.js";
import { register as compare } from "../src/tools/compare-periods.js";
import { createMockClient, getToolHandler } from "./tools/_helpers.js";

const meta = {
  imports_included: false,
  imports_skip_reason: "unsupported_query",
  imports_warning: "Imports cannot be included with these filters.",
  metric_warnings: { total_revenue: { code: "no_revenue_goals_matching", warning: "No matching revenue goals." } },
  total_rows: 1,
  future_metadata: { nested: [null, false, "preserve me"] },
};
const query = {
  site_id: "example.com",
  date_range: ["2026-09-01T00:00:00+02:00", "2026-09-30T23:59:59+02:00"],
  metrics: ["total_revenue"], dimensions: ["event:goal"],
  filters: [["is", "event:goal", ["Purchase"]]],
  include: { imports: true }, order_by: [["total_revenue", "desc"]],
};

describe.each([
  ["get_timeseries", timeseries, { date_range: "30d", granularity: "day", metrics: ["total_revenue"] }],
  ["get_breakdown", breakdown, { date_range: "30d", dimension: "event:goal", metrics: ["total_revenue"] }],
  ["get_conversions", conversions, { date_range: "30d" }],
] as const)("%s upstream context", (name, register, args) => {
  function setup(response: unknown) {
    const server = new McpServer({ name: "test", version: "1" });
    register(server, createMockClient(response), "example.com");
    return { handler: getToolHandler(server, name), tool: (server as any)._registeredTools[name] };
  }
  it("preserves warnings, resolved scope, unknown nested fields and null metrics in validated structured output", async () => {
    const { handler, tool } = setup({ results: [{ dimensions: ["Purchase"], metrics: [null] }], meta, query });
    const result = await handler({ ...args, include_imports: true });
    expect(result.isError).toBeUndefined();
    const validated = tool.outputSchema.parse(result.structuredContent);
    expect(validated).toMatchObject({ meta, query, results: [{ dimensions: ["Purchase"], metrics: [null] }] });
    const text = JSON.parse(result.content[0].text);
    expect(validated.meta).toEqual(text.meta);
    expect(validated.query).toEqual(text.query);
  });
  it.each([{}, { meta: {} }, { query: {} }, { meta: {}, query: {} }])("does not manufacture absent context: %j", async (context) => {
    const { handler, tool } = setup({ results: [], ...context });
    const result = await handler(args);
    expect(result.isError).toBeUndefined();
    const validated = tool.outputSchema.parse(result.structuredContent);
    expect(Object.hasOwn(validated, "meta")).toBe(Object.hasOwn(context, "meta"));
    expect(Object.hasOwn(validated, "query")).toBe(Object.hasOwn(context, "query"));
  });
});

describe("comparison upstream context", () => {
  function setup() {
    const server = new McpServer({ name: "test", version: "1" });
    const client = createMockClient();
    compare(server, client, "example.com");
    return { client, handler: getToolHandler(server, "compare_periods"), tool: (server as any)._registeredTools.compare_periods };
  }
  it("retains different per-period warnings and resolved ranges with null-aware deltas", async () => {
    const { client, handler, tool } = setup();
    const metaB = { imports_included: true, metric_warnings: {}, custom_coverage: "period B" };
    const queryB = { ...query, date_range: ["2026-10-01T00:00:00+02:00", "2026-10-14T23:59:59+02:00"] };
    client.query.mockResolvedValueOnce({ results: [{ dimensions: [], metrics: [null, 10] }], meta, query })
      .mockResolvedValueOnce({ results: [{ dimensions: [], metrics: [50, 20] }], meta: metaB, query: queryB });
    const result = await handler({ period_a: "30d", period_b: "month", metrics: ["total_revenue", "visitors"], include_imports: true });
    const validated = tool.outputSchema.parse(result.structuredContent);
    expect(validated.period_a).toMatchObject({ range: "30d", metrics: { total_revenue: null, visitors: 10 }, meta, query });
    expect(validated.period_b).toMatchObject({ range: "month", metrics: { total_revenue: 50, visitors: 20 }, meta: metaB, query: queryB });
    expect(validated.deltas).toEqual({ total_revenue: { absolute: null, percent: null }, visitors: { absolute: 10, percent: 100 } });
    expect(JSON.parse(result.content[0].text)).toEqual(validated);
  });
  it("does not copy one period's context into a period with missing fields", async () => {
    const { client, handler } = setup();
    client.query.mockResolvedValueOnce({ results: [], meta, query }).mockResolvedValueOnce({ results: [] });
    const result = await handler({ period_a: "30d", period_b: "7d" });
    expect(result.structuredContent.period_a).toMatchObject({ meta, query });
    expect(result.structuredContent.period_b).not.toHaveProperty("meta");
    expect(result.structuredContent.period_b).not.toHaveProperty("query");
  });
});
