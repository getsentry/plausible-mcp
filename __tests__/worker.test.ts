import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { clearCertsCache } from "../src/cf-access.js";
import type { Env } from "../src/env.js";
import {
  makeValidJwt,
  stubUpstream,
  timeseries,
  toolsList,
  workerClient,
  workerFetch,
  WORKER_ENV,
} from "./worker-fixtures.js";

describe("MCP Worker entry", () => {
  it("allows the modern protocol headers in CORS preflights", async () => {
    const response = await workerFetch(
      new Request("https://test.local/mcp", {
        method: "OPTIONS",
        headers: { Origin: "https://client.example" },
      }),
    );

    expect(response.status).toBe(204);
    const allowed = response.headers.get("Access-Control-Allow-Headers") ?? "";
    expect(allowed).toContain("Mcp-Method");
    expect(allowed).toContain("Mcp-Name");
    expect(allowed).toContain("MCP-Protocol-Version");
    expect(allowed).not.toContain("Mcp-Session-Id");
    expect(response.headers.get("Access-Control-Expose-Headers")).toBe("WWW-Authenticate");
  });

  it("returns a bearer challenge for BYOK authentication failures", async () => {
    const missing = await workerFetch(
      new Request("https://test.local/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(missing.status).toBe(401);
    expect(missing.headers.get("WWW-Authenticate")).toBe(
      'Bearer realm="plausible-mcp", error="invalid_request"',
    );

    const tooShort = await workerFetch(
      new Request("https://test.local/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer short",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(tooShort.status).toBe(401);
    expect(tooShort.headers.get("WWW-Authenticate")).toBe(
      'Bearer realm="plausible-mcp", error="invalid_token"',
    );
  });

  it("answers a malformed JSON body with a JSON-RPC parse error, not a 500", async () => {
    const response = await workerFetch(
      new Request("https://test.local/mcp", {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer test-key-123",
          "Content-Type": "application/json",
        },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"broken":',
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32700 } });
  });

  const byokKey = { Authorization: "Bearer test-key-123" };
  interface RequestCheck {
    label: string;
    path?: string;
    headers: Record<string, string>;
    env?: Partial<Env>;
    status: number;
  }
  it.each<RequestCheck>([
    { label: "an unlisted Host", headers: { ...byokKey, Host: "evil.example" }, status: 403 },
    { label: "an opaque Origin", headers: { ...byokKey, Origin: "null" }, status: 403 },
    // /mcp is open to any browser origin; the key is what authenticates it.
    {
      label: "a browser Origin without a key",
      headers: { Origin: "https://browser.example" },
      status: 401,
    },
    {
      label: "an unlisted browser Origin on /internal",
      path: "/internal",
      headers: { Origin: "https://browser.example" },
      status: 403,
    },
    {
      label: "a non-JSON media type",
      headers: { ...byokKey, "Content-Type": "text/plain; note=application/json" },
      status: 415,
    },
    {
      label: "no allowed hostnames configured",
      headers: byokKey,
      env: { MCP_ALLOWED_HOSTNAMES: " " },
      status: 500,
    },
  ])("answers a request with $label", async ({ path = "/mcp", headers, env = {}, status }) => {
    const envOverride = env;
    const response = await workerFetch(
      new Request(`https://test.local${path}`, {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      { ...WORKER_ENV, ...envOverride },
    );

    expect(response.status).toBe(status);
  });

  it("lets a listed browser Origin reach the /internal Access check", async () => {
    const response = await workerFetch(
      new Request("https://test.local/internal", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://browser.example" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      { ...WORKER_ENV, MCP_ALLOWED_ORIGIN_HOSTNAMES: "browser.example" },
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("missing Cloudflare Access assertion");
  });

  it("serves modern and legacy clients from the BYOK endpoint", async () => {
    const makeTransport = () =>
      new StreamableHTTPClientTransport(new URL("https://test.local/mcp"), {
        requestInit: { headers: { Authorization: "Bearer test-key-123" } },
        fetch: (url, init) => workerFetch(new Request(url, init)),
      });
    const modern = new Client(
      { name: "worker-modern-test", version: "0.0.1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const legacy = new Client({ name: "worker-legacy-test", version: "0.0.1" });

    try {
      await modern.connect(makeTransport());
      expect(modern.getProtocolEra()).toBe("modern");
      const { tools } = await modern.listTools();
      expect(tools).toHaveLength(5);
      const list = await modern.listResources();
      expect(list).toMatchObject({ ttlMs: 3_600_000, cacheScope: "public" });
      const { resources } = list;
      expect(resources).toHaveLength(1);
      const { uri, mimeType } = resources[0];
      expect(mimeType).toBe("text/html;profile=mcp-app");
      for (const tool of tools) {
        const expected =
          tool.name === "send_feedback"
            ? { resourceUri: uri, visibility: ["model"] }
            : { resourceUri: uri };
        expect(tool._meta?.ui).toEqual(expected);
      }
      const resource = await modern.readResource({ uri });
      expect(resource).toMatchObject({
        ttlMs: 3_600_000,
        cacheScope: "public",
        contents: [
          {
            uri,
            mimeType,
            _meta: { ui: { prefersBorder: true } },
            text: expect.stringContaining("ui/initialize"),
          },
        ],
      });

      await legacy.connect(makeTransport());
      expect(legacy.getProtocolEra()).toBe("legacy");
      expect((await legacy.listTools()).tools).toHaveLength(5);
    } finally {
      await modern.close();
      await legacy.close();
    }
  });
});

describe("public landing hostname", () => {
  const env = { ...WORKER_ENV, LANDING_HOSTNAME: "test.local" };
  it("serves the page only on the configured hostname", async () => {
    const read = (url: string, method = "GET") => workerFetch(new Request(url, { method }), env);
    const page = await read("https://test.local/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    // Rendering and the shipped app embed are covered in evals/ui.spec.mjs
    // "landing page renders the shipped app and switches installation instructions".
    const html = await page.text();
    expect(html).toContain("https://test.local/mcp");
    expect(html).not.toContain("plausible-mcp.sentry.dev");
    expect(await (await read("https://test.local/", "HEAD")).text()).toBe("");
    const post = await read("https://test.local/", "POST");
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET, HEAD");
    expect((await read("https://test.local/mcp")).status).toBe(401);
    expect((await read("https://test.local/internal")).status).toBe(403);
    expect((await read("https://test.local/unknown")).status).toBe(404);
    expect((await read("https://elsewhere.example/")).status).toBe(404);
  });
  it("applies the rate limiter to untracked paths too", async () => {
    const response = await workerFetch(new Request("https://test.local/wp-admin"), {
      ...WORKER_ENV,
      RATE_LIMITER: { limit: () => Promise.resolve({ success: false }) },
    });
    expect(response.status).toBe(429);
  });

  it("applies the existing rate limiter to the public page", async () => {
    const response = await workerFetch(new Request("https://test.local/"), {
      ...env,
      RATE_LIMITER: { limit: () => Promise.resolve({ success: false }) },
    });
    expect(response.status).toBe(429);
  });
});

describe("Worker endpoints end to end", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearCertsCache();
  });

  // The Worker builds a server per request, so one caller's key must never serve another's.
  it("queries Plausible with each BYOK caller's own key", async () => {
    const upstream = stubUpstream();
    const a = workerClient("/mcp", { Authorization: "Bearer key-aaaa-1111" });
    const b = workerClient("/mcp", { Authorization: "bearer key-bbbb-2222" });
    try {
      await a.connect();
      await b.connect();
      await a.client.callTool(timeseries);
      await b.client.callTool(timeseries);
      await a.client.callTool(timeseries);
    } finally {
      await a.client.close();
      await b.client.close();
    }

    expect(upstream.plausibleAuth).toEqual([
      "Bearer key-aaaa-1111",
      "Bearer key-bbbb-2222",
      "Bearer key-aaaa-1111",
    ]);
  });

  it("queries Plausible from /internal with the shared key, never the Access assertion", async () => {
    const { jwt, jwk } = await makeValidJwt();
    const upstream = stubUpstream(jwk);
    const env = { ...WORKER_ENV, PLAUSIBLE_API_KEY: "shared-key-1234" } satisfies Env;
    const internal = workerClient("/internal", { "Cf-Access-Jwt-Assertion": jwt }, env);
    try {
      await internal.connect();
      const result = await internal.client.callTool(timeseries);
      expect(result.isError).toBeFalsy();
    } finally {
      await internal.client.close();
    }

    expect(upstream.plausibleAuth).toEqual(["Bearer shared-key-1234"]);
  });

  it.each([
    ["no Access assertion", {}, {}, 403],
    ["an assertion that does not verify", { "Cf-Access-Jwt-Assertion": "a.b.c" }, {}, 403],
    ["no Access verification config", {}, { CF_ACCESS_TEAM_DOMAIN: undefined }, 500],
  ])("refuses /internal with %s", async (_case, headers, envOverride, status) => {
    stubUpstream();
    const response = await workerFetch(toolsList("/internal", headers), {
      ...WORKER_ENV,
      PLAUSIBLE_API_KEY: "shared-key-1234",
      ...envOverride,
    });

    expect(response.status).toBe(status);
  });

  it("refuses /internal without the shared key even for a valid identity", async () => {
    const { jwt, jwk } = await makeValidJwt();
    const upstream = stubUpstream(jwk);

    const response = await workerFetch(toolsList("/internal", { "Cf-Access-Jwt-Assertion": jwt }));

    expect(response.status).toBe(500);
    expect(upstream.plausibleAuth).toEqual([]);
  });

  it.each([
    ["a bare key with no scheme", "key-aaaa-1111", 401],
    ["a Basic credential", "Basic a2V5LWFhYWEtMTExMQ==", 401],
    ["an empty bearer", "Bearer ", 401],
    ["a lowercase bearer scheme", "bearer key-aaaa-1111", 200],
    ["an 8-character key", "Bearer 12345678", 200],
  ])("answers /mcp with %s", async (_case, authorization, status) => {
    stubUpstream();
    const response = await workerFetch(toolsList("/mcp", { Authorization: authorization }));

    expect(response.status).toBe(status);
  });

  // Regression (2a69caf): a failure inside the MCP handler reached no one. Plausible base URLs
  // must be HTTPS, so an HTTP one makes server creation throw inside the handler.
});
