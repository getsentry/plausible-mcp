import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { register as registerTimeseries } from "../../src/tools/get-timeseries.js";
import { register as registerBreakdown } from "../../src/tools/get-breakdown.js";
import { register as registerConversions } from "../../src/tools/get-conversions.js";
import { register as registerComparePeriods } from "../../src/tools/compare-periods.js";
import { createMockClient, getToolHandler } from "./_helpers.js";

const cases = [
  {
    tool: "get_timeseries",
    register: registerTimeseries,
    args: { date_range: "7d" },
    topLevelKeys: ["dimensions", "metrics", "results"],
  },
  {
    tool: "get_breakdown",
    register: registerBreakdown,
    args: { date_range: "7d", dimension: "event:page" },
    topLevelKeys: ["dimensions", "metrics", "pagination", "results"],
  },
  {
    tool: "get_conversions",
    register: registerConversions,
    args: { date_range: "7d" },
    topLevelKeys: ["dimensions", "metrics", "results"],
  },
  {
    tool: "compare_periods",
    register: registerComparePeriods,
    args: { period_a: "7d", period_b: "30d" },
    topLevelKeys: ["deltas", "period_a", "period_b"],
  },
];

function rows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    dimensions: [`row-${i}`],
    metrics: [i, i * 2, i / 2, i * 3],
  }));
}

describe.each(cases)("$tool structuredContent shape", ({ tool, register, args, topLevelKeys }) => {
  it.each([0, 1, 5])("matches the output schema with %i result rows", async (rowCount) => {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    register(server, createMockClient({ results: rows(rowCount), meta: {}, query: {} }), "default.com");
    const registered = (server as any)._registeredTools[tool];

    const result = await getToolHandler(server, tool)(args);

    expect(result.isError).toBeFalsy();
    expect(registered.outputSchema.safeParse(result.structuredContent).success).toBe(true);
    expect(Object.keys(result.structuredContent).sort()).toEqual(topLevelKeys);
  });
});
