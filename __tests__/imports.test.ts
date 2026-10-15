import { describe, expect, it, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { PlausibleClient } from "../src/plausible.js";
import { buildImportCoverage } from "../src/imports.js";
import { register as timeseries } from "../src/tools/get-timeseries.js";
import { register as breakdown } from "../src/tools/get-breakdown.js";
import { register as conversions } from "../src/tools/get-conversions.js";
import { register as compare } from "../src/tools/compare-periods.js";
import { createMockClient, getToolHandler } from "./tools/_helpers.js";

const response = (meta = {}) => ({ results: [{ dimensions: [], metrics: [100, 200, 3, 4] }], meta, query: {} });
const skipped = { imports_included: false, imports_skip_reason: "unsupported_query", imports_warning: "This filter/dimension combination does not support imports." };

describe.each([
  ["get_timeseries", timeseries, { date_range: "all", granularity: "day" }],
  ["get_breakdown", breakdown, { date_range: "all", dimension: "visit:source" }],
  ["get_conversions", conversions, { date_range: "all", breakdown_by_page: true }],
  ["compare_periods", compare, { period_a: "2020-01-01,2020-12-31", period_b: "2021-01-01,2021-12-31" }],
] as const)("%s imported history", (name, register, baseArgs) => {
  function setup(meta = {}) {
    const server = new McpServer({ name: "test", version: "1" });
    const client = createMockClient(response(meta));
    register(server, client, "example.com");
    return { server, client, handler: getToolHandler(server, name) };
  }
  const coverage = (result: any) => name === "compare_periods" ? result.period_a.imports : result.imports;
  it.each([true, false])("forwards explicit include_imports=%s and preserves scope", async (include_imports) => {
    const { client, handler, server } = setup({ imports_included: include_imports });
    const args = { ...baseArgs, page: "/pricing", property_filters: [{ property: "visit:source", operator: "is", values: ["Google"] }] };
    await handler(args);
    const previous = client.query.mock.calls.map((call) => call[0]);
    client.query.mockClear();
    const result = await handler({ ...args, include_imports });
    client.query.mock.calls.forEach(([query], i) => {
      expect(query).toEqual({ ...previous[i], include: { ...previous[i].include, imports: include_imports } });
    });
    expect(coverage(result.structuredContent)).toMatchObject({ requested: include_imports, imports_included: include_imports });
    expect(JSON.parse(result.content[0].text)).toMatchObject(name === "compare_periods" ? { period_a: { imports: coverage(result.structuredContent) } } : { imports: coverage(result.structuredContent) });
    expect((server as any)._registeredTools[name].outputSchema.safeParse(result.structuredContent).success).toBe(true);
  });
  it("keeps the native-only default and omits coverage if upstream provides none", async () => {
    const { client, handler } = setup();
    const result = await handler(baseArgs);
    for (const [query] of client.query.mock.calls) expect(query.include?.imports).toBeUndefined();
    expect(coverage(result.structuredContent)).toBeUndefined();
  });
  it("preserves skipped-import metadata and warns without replacing native metrics", async () => {
    const { handler } = setup(skipped);
    const result = await handler({ ...baseArgs, include_imports: true });
    expect(coverage(result.structuredContent)).toMatchObject(skipped);
    expect(coverage(result.structuredContent).warnings.join(" ")).toContain("not zero traffic");
    if (name !== "compare_periods") expect(result.structuredContent.results[0].metrics).toEqual([100, 200, 3, 4]);
  });
  it("warns about unconfirmed imported coverage on an empty response", async () => {
    const { client, handler } = setup();
    client.query.mockResolvedValue({ results: [], meta: {}, query: {} });
    const result = await handler({ ...baseArgs, include_imports: true });
    expect(coverage(result.structuredContent)).toMatchObject({ imports_included: null });
    expect(coverage(result.structuredContent).warnings.join(" ")).toContain("unknown");
    if (name !== "compare_periods") expect(result.structuredContent.results).toEqual([]);
  });
  it("rejects nonboolean inclusion settings", () => {
    const { server } = setup();
    expect((server as any)._registeredTools[name].inputSchema.safeParse({ ...baseArgs, include_imports: "true" }).success).toBe(false);
  });
});

describe("per-period coverage", () => {
  it("keeps differing upstream coverage separate without silently replacing native aggregates", async () => {
    const server = new McpServer({ name: "test", version: "1" });
    const client = createMockClient();
    compare(server, client, "example.com");
    client.query.mockResolvedValueOnce(response({ imports_included: true })).mockResolvedValueOnce(response(skipped));
    const result = await getToolHandler(server, "compare_periods")({ period_a: "7d", period_b: "30d", include_imports: true });
    expect(result.structuredContent.period_a.imports.imports_included).toBe(true);
    expect(result.structuredContent.period_b.imports).toMatchObject(skipped);
    expect(result.structuredContent.period_b.imports.warnings).not.toHaveLength(0);
    expect(result.structuredContent.period_a.metrics.visitors).toBe(100);
    expect(result.structuredContent.period_b.metrics.visitors).toBe(100);
  });
  it("preserves upstream import metadata even when the caller did not explicitly request imports", () => {
    expect(buildImportCoverage(response(skipped))).toMatchObject({ imports: skipped });
  });
});

describe("imports transport", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("merges imports and total_rows into the serialized include object", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(response({ imports_included: true })))));
    const client = new PlausibleClient({ apiKey: "key" });
    const result = await client.query({ site_id: "example.com", metrics: ["visitors"], date_range: "all", include: { imports: true, total_rows: true }, pagination: { limit: 20, offset: 40 } });
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toMatchObject({ include: { imports: true, total_rows: true }, pagination: { limit: 20, offset: 40 } });
    expect(result.meta.imports_included).toBe(true);
  });
});
