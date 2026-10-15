import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { PlausibleClient } from "../../src/plausible.js";
import { register } from "../../src/tools/get-sites.js";

describe("get_sites", () => {
  let handler: (args: Record<string, unknown>, ctx: unknown) => Promise<any>;
  beforeEach(() => {
    const server = new McpServer({ name: "test", version: "1" });
    register(server, new PlausibleClient({ apiKey: "caller-key", baseUrl: "https://analytics.example.com" }), "private.example");
    handler = (server as any)._registeredTools.get_sites.handler;
    vi.stubGlobal("fetch", vi.fn());
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  const respond = (body: unknown, status = 200) => vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));

  it("returns only authorized sites, paginates, and calculates today in each site zone", async () => {
    respond({ sites: [{ domain: "allowed.example", timezone: "America/Los_Angeles" }], meta: { after: "next" } });
    const { structuredContent: result } = await handler({ after: "a&b" }, {});
    expect(result.sites[0]).toEqual({ site_id: "allowed.example", timezone: "America/Los_Angeles", today: "2025-12-31", timezone_status: "available", is_default: false });
    expect(result.next_after).toBe("next");
    expect(JSON.stringify(result)).not.toContain("private.example");
    expect(fetch).toHaveBeenCalledWith("https://analytics.example.com/api/v1/sites?limit=100&after=a%26b", { method: "GET", headers: { Authorization: "Bearer caller-key" } });
  });
  it("verifies the default with the caller key before exposing it", async () => {
    respond({ domain: "private.example", timezone: "Pacific/Auckland" });
    const result = await handler({ use_default: true }, {});
    expect(result.structuredContent.sites[0]).toMatchObject({ site_id: "private.example", is_default: true, today: "2026-01-01" });
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://analytics.example.com/api/v1/sites/private.example");
  });
  it.each([401, 403, 404, 405, 429, 500, 501])("does not leak defaults or upstream bodies on HTTP %s", async (code) => {
    respond({ error: "private.example is secret" }, code);
    const { structuredContent: result } = await handler({ use_default: true }, {});
    expect(result.status).toBe([401, 403].includes(code) ? "permission_denied" : [404, 405, 501].includes(code) ? "unsupported" : "unavailable");
    expect(result.sites).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("private.example");
  });
  it.each([undefined, "Invalid/Zone", ""]) ("never infers missing or invalid zones: %s", async (timezone) => {
    respond({ sites: [{ domain: "allowed.example", timezone }], meta: { after: null } });
    const result = await handler({}, {});
    expect(result.structuredContent.sites[0]).toMatchObject({ timezone: null, today: null, timezone_status: "unavailable" });
  });
  it("rejects malformed responses without exposing partial data", async () => {
    respond({ sites: [{ domain: "allowed.example" }, { timezone: "UTC" }] });
    expect((await handler({}, {})).structuredContent.status).toBe("unavailable");
  });
  it("uses the site's daylight saving offset", async () => {
    vi.setSystemTime(new Date("2026-07-01T04:30:00Z"));
    respond({ sites: [{ domain: "allowed.example", timezone: "America/New_York" }], meta: { after: null } });
    expect((await handler({}, {})).structuredContent.sites[0].today).toBe("2026-07-01");
  });
  it("returns unavailable on network errors without echoing their messages", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("private.example"));
    const result = await handler({}, {});
    expect(result.structuredContent.status).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain("private.example");
  });
  it("does not request an unconfigured default or ambiguous inputs", async () => {
    const server = new McpServer({ name: "test", version: "1" });
    register(server, new PlausibleClient({ apiKey: "key" }));
    const bareHandler = (server as any)._registeredTools.get_sites.handler;
    expect((await bareHandler({ use_default: true }, {})).structuredContent.status).toBe("unavailable");
    expect((await handler({ site_id: "a", use_default: true }, {})).structuredContent.status).toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("encodes explicit site identifiers as a single path component", async () => {
    respond({ domain: "example.com/path", timezone: "UTC" });
    await handler({ site_id: "example.com/path" }, {});
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://analytics.example.com/api/v1/sites/example.com%2Fpath");
  });
});
