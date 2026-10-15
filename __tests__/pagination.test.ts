import { describe, expect, it, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { buildPagination } from "../src/pagination.js";
import { PlausibleClient, type PlausibleResponse } from "../src/plausible.js";
import { register as breakdown } from "../src/tools/get-breakdown.js";
import { register as conversions } from "../src/tools/get-conversions.js";
import { createMockClient, getToolHandler } from "./tools/_helpers.js";

function response(count: number, total?: unknown): PlausibleResponse {
  return { results: Array.from({ length: count }, (_, i) => ({ dimensions: [`row${i}`], metrics: [1] })), meta: { total_rows: total }, query: {} };
}

describe("pagination completeness", () => {
  it.each([
    [2, 5, 2, 0, "partial", true, 2],
    [2, 4, 2, 2, "partial", false, null],
    [2, 2, 2, 0, "complete", false, null],
    [0, 0, 2, 0, "complete", false, null],
    [0, 2, 2, 4, "partial", false, null],
    [2, undefined, 2, 0, "unknown", null, 2],
    [1, undefined, 2, 0, "unknown", null, 1],
    [0, undefined, 2, 0, "unknown", null, null],
    [0, 5, 2, 2, "unknown", null, null],
    [2, 1, 2, 0, "unknown", null, 2],
  ])("count=%s total=%s limit=%s offset=%s", (count, total, limit, offset, completeness, has_more, next_offset) => {
    expect(buildPagination(response(count as number, total), limit as number, offset as number)).toMatchObject({ completeness, has_more, next_offset });
  });
  it("warns if an upstream cap stops a page before the reported total", () => {
    expect(buildPagination(response(1, 10), 5, 0).warnings.join(" ")).toContain("cap");
  });
  it.each([-1, 1.5, "100", null, NaN, Infinity])("treats invalid totals %s as unknown", (total) => {
    expect(buildPagination(response(0, total), 20, 0)).toMatchObject({ total_rows: null, completeness: "unknown" });
  });
});

describe.each([
  ["get_breakdown", breakdown, { dimension: "event:page", metrics: ["events", "visitors"] }, ["event:page"], ["events", "visitors"], 1000],
  ["get_conversions", conversions, { breakdown_by_page: true, goal: "Signup" }, ["event:goal", "event:page"], ["visitors", "events", "conversion_rate"], 10000],
] as const)("%s pagination", (name, register, extra, dimensions, metrics, maximum) => {
  function setup() {
    const server = new McpServer({ name: "test", version: "1" });
    const client = createMockClient(response(2, 6));
    register(server, client, "example.com");
    return { server, client, handler: getToolHandler(server, name) };
  }
  it("retrieves a subsequent page without changing ranking, metrics or filters", async () => {
    const { client, handler } = setup();
    const args = { ...extra, date_range: "2026-01-01,2026-01-31", page: "/pricing", property_filters: [{ property: "plan", operator: "is", values: ["pro"] }], limit: 2 };
    const first = await handler(args);
    const next = first.structuredContent.pagination.next_offset;
    const second = await handler({ ...args, offset: next });
    const firstQuery = client.query.mock.calls[0][0];
    const secondQuery = client.query.mock.calls[1][0];
    expect(secondQuery).toEqual({ ...firstQuery, pagination: { limit: 2, offset: 2 } });
    expect(firstQuery).toMatchObject({ metrics, dimensions, include: { total_rows: true }, order_by: [[metrics[0], "desc"], ...dimensions.map((d) => [d, "asc"])], filters: expect.arrayContaining([["is", "event:page", ["/pricing"]], ["is", "event:props:plan", ["pro"]]]) });
    expect(second.structuredContent.pagination).toMatchObject({ offset: 2, completeness: "partial" });
    expect(JSON.parse(second.content[0].text).pagination).toEqual(second.structuredContent.pagination);
    const tool = (setup().server as any)._registeredTools[name];
    expect(tool.outputSchema.safeParse(second.structuredContent).success).toBe(true);
  });
  it("accepts boundary limits and offsets", () => {
    const { server } = setup();
    const schema = (server as any)._registeredTools[name].inputSchema;
    expect(schema.safeParse({ ...extra, date_range: "7d", limit: maximum, offset: 0 }).success).toBe(true);
    expect(schema.safeParse({ ...extra, date_range: "7d", limit: 1, offset: 10000 }).success).toBe(true);
  });
  it.each([{ limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: maximum + 1 }, { offset: -1 }, { offset: 0.5 }, { offset: Number.MAX_SAFE_INTEGER }, { offset: "2" }])("rejects invalid inputs %j", (invalid) => {
    const { server } = setup();
    const schema = (server as any)._registeredTools[name].inputSchema;
    expect(schema.safeParse({ ...extra, date_range: "7d", ...invalid }).success).toBe(false);
  });
});

describe("Plausible pagination transport", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("sends pagination, total-row inclusion and deterministic ordering in the POST body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(response(0, 0)))));
    const client = new PlausibleClient({ apiKey: "key" });
    await client.query({ site_id: "example.com", date_range: "7d", metrics: ["visitors"], dimensions: ["event:goal"], pagination: { limit: 2, offset: 4 }, include: { total_rows: true }, order_by: [["visitors", "desc"], ["event:goal", "asc"]] });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body).toMatchObject({ pagination: { limit: 2, offset: 4 }, include: { total_rows: true }, order_by: [["visitors", "desc"], ["event:goal", "asc"]] });
  });
});
