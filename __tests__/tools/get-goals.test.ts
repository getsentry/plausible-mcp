import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { PlausibleClient } from "../../src/plausible.js";
import { register } from "../../src/tools/get-goals.js";
import { getToolHandler } from "./_helpers.js";

const webinar = { id: "1", goal_type: "event", display_name: "Webinar registrations", event_name: "Register", page_path: null, custom_props: { category: "webinar" } };
const pageGoal = { id: "2", goal_type: "page", display_name: "Visit /thanks", event_name: null, page_path: "/thanks", custom_props: {} };

describe("configured goal discovery", () => {
  let server: McpServer;
  let handler: ReturnType<typeof getToolHandler>;
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    server = new McpServer({ name: "test", version: "1" });
    register(server, new PlausibleClient({ apiKey: "caller-key", baseUrl: "https://analytics.example.com" }), "default.example");
    handler = getToolHandler(server, "get_goals");
  });
  afterEach(() => vi.unstubAllGlobals());
  const respond = (body: unknown, status = 200) => vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
  it("returns definitions without requiring observed activity and uses the caller key and configured host", async () => {
    respond({ goals: [webinar, pageGoal], meta: { after: null } });
    const result = await handler({ site_id: "example.com" });
    expect(result.structuredContent).toMatchObject({ status: "available", site_id: "example.com", goals: [webinar, pageGoal], completeness: "complete" });
    expect(fetch).toHaveBeenCalledExactlyOnceWith("https://analytics.example.com/api/v1/sites/goals?site_id=example.com&limit=100", { method: "GET", headers: { Authorization: "Bearer caller-key" } });
    expect(result.structuredContent.goals[0]).not.toHaveProperty("conversions");
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect((server as any)._registeredTools.get_goals.outputSchema.parse(result.structuredContent)).toEqual(result.structuredContent);
  });
  it("distinguishes a confirmed empty configuration from unavailable discovery", async () => {
    respond({ goals: [], meta: { after: null } });
    const result = await handler({});
    expect(result.structuredContent).toMatchObject({ status: "available", goals: [], completeness: "complete", site_id: "default.example" });
  });
  it("paginates configuration without confusing a terminal page with a full inventory", async () => {
    respond({ goals: [webinar], meta: { after: "a&b" } });
    respond({ goals: [pageGoal], meta: { after: null } });
    const first = await handler({});
    const second = await handler({ after: first.structuredContent.next_after });
    expect(first.structuredContent.completeness).toBe("partial");
    expect(second.structuredContent).toMatchObject({ completeness: "partial", next_after: null, goals: [pageGoal] });
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe("https://analytics.example.com/api/v1/sites/goals?site_id=default.example&limit=100&after=a%26b");
  });
  it.each([401, 403, 404, 405, 429, 500, 501])("reports HTTP %s without leaking upstream configuration or default IDs", async (code) => {
    respond({ error: "default.example secret goal Webinar registrations", goals: [webinar] }, code);
    const result = await handler({});
    expect(result.structuredContent).toMatchObject({ status: [401, 403].includes(code) ? "permission_denied" : [404, 405, 501].includes(code) ? "unsupported" : "unavailable", completeness: "unknown", goals: [] });
    expect(JSON.stringify(result)).not.toContain("default.example");
    expect(JSON.stringify(result)).not.toContain("Webinar registrations");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([{ goals: [] }, { goals: [{}], meta: { after: null } }, { goals: [], meta: {} }])("rejects incomplete or malformed metadata rather than claiming no goals: %j", async (body) => {
    respond(body);
    expect((await handler({})).structuredContent.status).toBe("unavailable");
  });
  it("preserves additional definition fields", async () => {
    respond({ goals: [{ ...webinar, revenue: { currency: "EUR" } }], meta: { after: null } });
    expect((await handler({})).structuredContent.goals[0].revenue).toEqual({ currency: "EUR" });
  });
  it("handles network failure as unknown configuration", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("secret private detail"));
    const result = await handler({});
    expect(result.structuredContent.status).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain("secret private detail");
  });
  it("requires a site without a default and makes no request when absent", async () => {
    const bare = new McpServer({ name: "test", version: "1" });
    register(bare, new PlausibleClient({ apiKey: "key" }));
    expect((bare as any)._registeredTools.get_goals.inputSchema.safeParse({}).success).toBe(false);
    expect((await getToolHandler(bare, "get_goals")({})).structuredContent.status).toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });
});
