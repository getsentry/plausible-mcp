import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { buildPageFilter, buildPropertyFilters } from "../src/schemas.js";
import { PlausibleApiError } from "../src/plausible.js";
import { register as timeseries } from "../src/tools/get-timeseries.js";
import { register as breakdown } from "../src/tools/get-breakdown.js";
import { register as conversions } from "../src/tools/get-conversions.js";
import { register as compare } from "../src/tools/compare-periods.js";
import { createMockClient, getToolHandler } from "./tools/_helpers.js";

describe("literal page matching", () => {
  it("distinguishes exact, prefix and explicit substring scopes", () => {
    expect(buildPageFilter("/traineeship")).toEqual(["is", "event:page", ["/traineeship"]]);
    const prefix = buildPageFilter("/traineeship*");
    expect(prefix).toEqual(["matches", "event:page", ["^/traineeship"]]);
    const pattern = new RegExp((prefix[2] as string[])[0]);
    expect(["/traineeship", "/traineeship/apply", "/archive/traineeship"].map((path) => pattern.test(path))).toEqual([true, true, false]);
    expect(buildPropertyFilters([{ property: "event:page", operator: "contains", values: ["/traineeship"] }])).toEqual([["contains", "event:page", ["/traineeship"]]]);
  });
  it.each(["/v1.2", "/a+b", "/a?b", "/a(b)", "/a[b]", "/a{b}", "/a|b", "/a^b$c", "/a\\b", "/a*b", "/é/教育"])("escapes a literal prefix %s", (prefix) => {
    const filter = buildPageFilter(`${prefix}*`);
    const regex = new RegExp((filter[2] as string[])[0]);
    expect(regex.test(prefix)).toBe(true);
    expect(regex.test(`${prefix}/child`)).toBe(true);
    expect(regex.test(`/archive${prefix}`)).toBe(false);
  });
  it("does not interpret dots as arbitrary characters", () => {
    const filter = buildPageFilter("/v1.2*");
    expect(filter).toEqual(["matches", "event:page", ["^/v1\\.2"]]);
    expect(new RegExp((filter[2] as string[])[0]).test("/v1x2")).toBe(false);
  });
  it("keeps root and all-path prefixes well-defined", () => {
    expect(buildPageFilter("/*")).toEqual(["matches", "event:page", ["^/"]]);
    expect(buildPageFilter("*")).toEqual(["matches", "event:page", ["^"]]);
    expect(buildPageFilter("/")).toEqual(["is", "event:page", ["/"]]);
    expect(buildPageFilter("/a*b")).toEqual(["is", "event:page", ["/a*b"]]);
  });
});

describe.each([
  ["get_timeseries", timeseries, { date_range: "7d", granularity: "day" }],
  ["get_breakdown", breakdown, { date_range: "7d", dimension: "event:page" }],
  ["get_conversions", conversions, { date_range: "7d" }],
  ["compare_periods", compare, { period_a: "7d", period_b: "30d" }],
] as const)("%s page semantics", (name, register, args) => {
  function setup() {
    const server = new McpServer({ name: "test", version: "1" });
    const client = createMockClient();
    register(server, client, "example.com");
    return { client, handler: getToolHandler(server, name), tool: (server as any)._registeredTools[name] };
  }
  it.each(["/traineeship", "/traineeship*"])("forwards %s consistently and retains effective returned filters", async (page) => {
    const { client, handler, tool } = setup();
    const filter = buildPageFilter(page);
    client.query.mockImplementation(async (query) => ({ results: [], meta: {}, query }));
    const result = await handler({ ...args, page });
    for (const [query] of client.query.mock.calls) expect(query.filters).toEqual([filter]);
    const structured = tool.outputSchema.parse(result.structuredContent);
    if (name === "compare_periods") {
      expect(structured.period_a.query.filters).toEqual([filter]);
      expect(structured.period_b.query.filters).toEqual([filter]);
    } else expect(structured.query.filters).toEqual([filter]);
    expect(tool.inputSchema.shape.page.description).toContain("literal prefix");
  });
  it("returns upstream rejection honestly without retrying as contains", async () => {
    const { client, handler } = setup();
    client.query.mockRejectedValue(new PlausibleApiError(400, JSON.stringify({ error: "matches is unsupported" })));
    const result = await handler({ ...args, page: "/traineeship*" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("matches is unsupported");
    expect(client.query).toHaveBeenCalledTimes(name === "compare_periods" ? 2 : 1);
    for (const [query] of client.query.mock.calls) expect(query.filters).toEqual([["matches", "event:page", ["^/traineeship"]]]);
  });
});
