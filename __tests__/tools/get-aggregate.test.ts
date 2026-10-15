import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { register } from "../../src/tools/get-aggregate.js";
import { PlausibleClient, PlausibleApiError } from "../../src/plausible.js";
import { createMockClient, getToolHandler } from "./_helpers.js";

const metrics = ["visitors", "visits", "pageviews", "bounce_rate", "visit_duration"];
describe("get_aggregate", () => {
  let client: ReturnType<typeof createMockClient>;
  let server: McpServer;
  let handler: ReturnType<typeof getToolHandler>;
  beforeEach(() => {
    client = createMockClient({ results: [{ dimensions: [], metrics: [101, 150, 200, 42, 75] }], meta: {}, query: {} });
    server = new McpServer({ name: "test", version: "1" });
    register(server, client, "example.com");
    handler = getToolHandler(server, "get_aggregate");
  });
  afterEach(() => vi.unstubAllGlobals());
  it("gets the five-KPI overview from exactly one dimensionless interval query", async () => {
    const result = await handler({ date_range: "2026-09-01,2026-09-30" });
    expect(client.query).toHaveBeenCalledExactlyOnceWith({ site_id: "example.com", metrics, date_range: "2026-09-01,2026-09-30", dimensions: [], filters: [] });
    expect(result.structuredContent).toMatchObject({ metrics, dimensions: [], results: [{ dimensions: [], metrics: [101, 150, 200, 42, 75] }] });
    expect((server as any)._registeredTools.get_aggregate.outputSchema.safeParse(result.structuredContent).success).toBe(true);
  });
  it("preserves explicit metrics, site and all filters with literal prefix scope", async () => {
    await handler({ site_id: "other.example", date_range: "7d", metrics: ["events", "visitors", "conversion_rate"], page: "/webinar*", goal: "Registration", property_filters: [{ property: "plan", operator: "is", values: ["pro"] }], include_imports: true });
    expect(client.query).toHaveBeenCalledExactlyOnceWith({ site_id: "other.example", date_range: "7d", metrics: ["events", "visitors", "conversion_rate"], dimensions: [], include: { imports: true }, filters: [["matches", "event:page", ["^/webinar"]], ["is", "event:goal", ["Registration"]], ["is", "event:props:plan", ["pro"]]] });
  });
  it("preserves exact page matching", async () => {
    await handler({ date_range: "7d", page: "/pricing" });
    expect(client.query.mock.calls[0][0].filters).toEqual([["is", "event:page", ["/pricing"]]]);
  });
  it("preserves nulls, zeros, upstream warnings and resolved scope", async () => {
    const meta = { imports_included: false, imports_skip_reason: "unsupported_query", imports_warning: "Imports unavailable", metric_warnings: { total_revenue: { code: "no_revenue_goals_matching" } } };
    const query = { date_range: ["2026-09-01T00:00:00Z", "2026-09-30T23:59:59Z"], dimensions: [], metrics: ["total_revenue", "visitors"] };
    client.query.mockResolvedValue({ results: [{ dimensions: [], metrics: [null, 0] }], meta, query });
    const result = await handler({ date_range: "30d", metrics: ["total_revenue", "visitors"], include_imports: true });
    expect(result.structuredContent).toMatchObject({ meta, query, results: [{ dimensions: [], metrics: [null, 0] }], imports: { imports_included: false } });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ meta, query });
  });
  it("does not replace empty results with zero aggregates or manufacture context", async () => {
    client.query.mockResolvedValue({ results: [] });
    const result = await handler({ date_range: "7d" });
    expect(result.structuredContent).toEqual({ metrics, dimensions: [], results: [] });
  });
  it.each(["event:page", "event:goal"])("rejects overlapping %s shortcuts before fetching", async (property) => {
    const result = await handler({ date_range: "7d", page: "/pricing", goal: "Signup", property_filters: [{ property, values: ["other"] }] });
    expect(result.isError).toBe(true);
    expect(client.query).not.toHaveBeenCalled();
  });
  it.each([400, 401, 429, 503])("retains HTTP %s errors without retrying or changing incompatible metrics", async (status) => {
    client.query.mockRejectedValue(new PlausibleApiError(status, JSON.stringify({ error: "Metric/filter combination unsupported" })));
    const result = await handler({ date_range: "7d", goal: "Signup" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Metric/filter combination unsupported");
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0][0].metrics).toEqual(metrics);
  });
  it("rejects invalid metrics and requires a site when no default exists", () => {
    const bare = new McpServer({ name: "test", version: "1" });
    register(bare, client);
    const schema = (bare as any)._registeredTools.get_aggregate.inputSchema;
    expect(schema.safeParse({ date_range: "7d" }).success).toBe(false);
    expect(schema.safeParse({ site_id: "example.com", date_range: "7d", metrics: ["invented"] }).success).toBe(false);
  });
  it("serializes one POST without dimensions or time grouping", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [], meta: {}, query: {} }))));
    const actual = new McpServer({ name: "test", version: "1" });
    register(actual, new PlausibleClient({ apiKey: "key" }), "example.com");
    await getToolHandler(actual, "get_aggregate")({ date_range: "2026-09-01,2026-09-30" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body).toEqual({ site_id: "example.com", metrics, date_range: ["2026-09-01", "2026-09-30"] });
  });
});
