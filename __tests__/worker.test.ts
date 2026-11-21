import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  verifyCloudflareAccessJwt,
  clearCertsCache,
  parseAllowedEmailDomains,
  parseAllowedServiceTokenIds,
  type AccessConfig,
} from "../src/cf-access.js";
import instrumentedWorker, { workerHandler } from "../src/worker.js";
import { HEARTBEAT_SPAN_KEEP_RATE } from "../src/telemetry.js";
import type { Env } from "../src/env.js";

const TEAM_DOMAIN = "https://sentry.cloudflareaccess.com";
const AUD = "test-audience-tag";

const config: AccessConfig = {
  teamDomain: TEAM_DOMAIN,
  aud: AUD,
  allowedEmailDomains: ["sentry.io"],
};

const WORKER_ENV = {
  CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  CF_ACCESS_AUD: AUD,
  MCP_ALLOWED_HOSTNAMES: "test.local",
} satisfies Env;

function workerFetch(request: Request, env: Env = WORKER_ENV): Promise<Response> {
  if (!request.headers.has("Host")) {
    request.headers.set("Host", new URL(request.url).host);
  }
  return workerHandler.fetch(request, env, {} as ExecutionContext);
}

function base64Url(obj: Record<string, unknown>): string {
  return btoa(JSON.stringify(obj))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generateKeyPair() {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
}

async function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: CryptoKey,
): Promise<string> {
  const headerB64 = base64Url(header);
  const payloadB64 = base64Url(payload);
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, data);
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

async function makeValidJwt(overrides: {
  header?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  kid?: string;
} = {}) {
  const keyPair = await generateKeyPair();
  const kid = overrides.kid ?? "test-kid";
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  (jwk as Record<string, unknown>).kid = kid;

  const header = { alg: "RS256", kid, ...overrides.header };
  const payload = {
    email: "user@sentry.io",
    aud: [AUD],
    iss: TEAM_DOMAIN,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    ...overrides.payload,
  };

  const jwt = await signJwt(header, payload, keyPair.privateKey);
  return { jwt, jwk, keyPair };
}

function mockCertsEndpoint(jwk: JsonWebKey) {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })),
  );
}

/** Attributes of every span in the given Sentry envelopes (one envelope per string), values unwrapped. */
function exportedSpans(envelopes: string[]): Array<Record<string, unknown>> {
  return envelopes.flatMap((text) => {
    const lines = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const spans: Array<Record<string, unknown>> = [];
    // An envelope is a header line, then item-header and payload lines in pairs.
    for (let i = 1; i + 1 < lines.length; i += 2) {
      if (lines[i].type !== "span") continue;
      for (const span of lines[i + 1].items) {
        spans.push({
          is_segment: span.is_segment,
          ...Object.fromEntries(
            Object.entries(span.attributes ?? {}).map(([key, attribute]) => [key, (attribute as { value: unknown }).value]),
          ),
        });
      }
    }
    return spans;
  });
}

describe("verifyCloudflareAccessJwt", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearCertsCache();
  });

  it("returns null for malformed JWT", async () => {
    expect(await verifyCloudflareAccessJwt("not.a.valid.jwt.token", config)).toBeNull();
    expect(await verifyCloudflareAccessJwt("", config)).toBeNull();
    expect(await verifyCloudflareAccessJwt("onepart", config)).toBeNull();
  });

  it("fails closed (returns null, does not throw) when a segment isn't valid base64/JSON", async () => {
    const { jwk } = await makeValidJwt();
    mockCertsEndpoint(jwk);

    // Three parts (so it passes the length check and reaches segment decoding), but the
    // header/payload aren't valid base64url-encoded JSON — atob/JSON.parse would throw.
    const notJson = btoa("not json {").replace(/=+$/, "");
    const invalidBase64 = "@@@";

    await expect(
      verifyCloudflareAccessJwt(`${notJson}.${notJson}.${notJson}`, config),
    ).resolves.toBeNull();
    await expect(
      verifyCloudflareAccessJwt(`${invalidBase64}.${invalidBase64}.${invalidBase64}`, config),
    ).resolves.toBeNull();
  });

  it("returns email for a valid JWT", async () => {
    const { jwt, jwk } = await makeValidJwt();
    mockCertsEndpoint(jwk);

    const result = await verifyCloudflareAccessJwt(jwt, config);
    expect(result).toEqual({ kind: "user", email: "user@sentry.io" });
  });

  it("returns the lowercased email so attribution is stable", async () => {
    const { jwt, jwk } = await makeValidJwt({
      payload: { email: "User.Name@Sentry.IO" },
    });
    mockCertsEndpoint(jwk);

    expect(await verifyCloudflareAccessJwt(jwt, config)).toEqual({
      kind: "user",
      email: "user.name@sentry.io",
    });
  });

  it("returns null for expired JWT", async () => {
    const { jwt, jwk } = await makeValidJwt({
      payload: { exp: Math.floor(Date.now() / 1000) - 60 },
    });
    mockCertsEndpoint(jwk);

    expect(await verifyCloudflareAccessJwt(jwt, config)).toBeNull();
  });

  it("returns null for wrong audience", async () => {
    const { jwt, jwk } = await makeValidJwt({
      payload: { aud: ["wrong-audience"] },
    });
    mockCertsEndpoint(jwk);

    expect(await verifyCloudflareAccessJwt(jwt, config)).toBeNull();
  });

  it("handles aud as a string (not array)", async () => {
    const { jwt, jwk } = await makeValidJwt({
      payload: { aud: AUD },
    });
    mockCertsEndpoint(jwk);

    expect(await verifyCloudflareAccessJwt(jwt, config)).toEqual({
      kind: "user",
      email: "user@sentry.io",
    });
  });

  it("returns null for non-sentry.io email", async () => {
    const { jwt, jwk } = await makeValidJwt({
      payload: { email: "hacker@evil.com" },
    });
    mockCertsEndpoint(jwk);

    expect(await verifyCloudflareAccessJwt(jwt, config)).toBeNull();
  });

  it("rejects a subdomain of an allowed domain (the gate is @-anchored)", async () => {
    // e.g. user@evil.sentry.io must NOT pass the sentry.io allowlist: endsWith("@sentry.io")
    // is false because the char before "sentry.io" is ".", not "@".
    const { jwt, jwk } = await makeValidJwt({
      payload: { email: "user@evil.sentry.io" },
    });
    mockCertsEndpoint(jwk);

    expect(await verifyCloudflareAccessJwt(jwt, config)).toBeNull();
  });

  it("accepts an email in a configured custom domain (self-hosting)", async () => {
    const { jwt, jwk } = await makeValidJwt({
      payload: { email: "user@acme.com" },
    });
    mockCertsEndpoint(jwk);

    const customConfig: AccessConfig = {
      ...config,
      allowedEmailDomains: ["acme.com", "contractors.acme.com"],
    };
    expect(await verifyCloudflareAccessJwt(jwt, customConfig)).toEqual({
      kind: "user",
      email: "user@acme.com",
    });
    // The default sentry.io gate must NOT admit the custom-domain user.
    expect(await verifyCloudflareAccessJwt(jwt, config)).toBeNull();
  });

  it("returns null for wrong issuer", async () => {
    const { jwt, jwk } = await makeValidJwt({
      payload: { iss: "https://evil.cloudflareaccess.com" },
    });
    mockCertsEndpoint(jwk);

    expect(await verifyCloudflareAccessJwt(jwt, config)).toBeNull();
  });

  it("normalizes a trailing slash on teamDomain so the issuer still matches", async () => {
    const { jwt, jwk } = await makeValidJwt();
    mockCertsEndpoint(jwk);

    // Access issues `iss` with no trailing slash; a misconfigured trailing slash on
    // CF_ACCESS_TEAM_DOMAIN must not reject every token.
    const trailingSlashConfig: AccessConfig = {
      ...config,
      teamDomain: `${TEAM_DOMAIN}/`,
    };
    expect(await verifyCloudflareAccessJwt(jwt, trailingSlashConfig)).toEqual({
      kind: "user",
      email: "user@sentry.io",
    });
  });

  it("returns null when exp equals now (rejects on the expiry second)", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const { jwt, jwk } = await makeValidJwt({ payload: { exp: nowSec } });
    mockCertsEndpoint(jwk);

    expect(await verifyCloudflareAccessJwt(jwt, config)).toBeNull();
  });

  it("returns null when kid doesn't match any cert even after refresh", async () => {
    const { jwt, jwk } = await makeValidJwt({ kid: "unknown-kid" });
    (jwk as Record<string, unknown>).kid = "different-kid";
    mockCertsEndpoint(jwk);

    expect(await verifyCloudflareAccessJwt(jwt, config)).toBeNull();
  });

  it("refreshes certs on kid miss and succeeds with rotated key", async () => {
    const { jwt, jwk } = await makeValidJwt();
    const staleJwk = { ...jwk, kid: "old-kid" } as JsonWebKey;
    let callCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      callCount++;
      const keys = callCount === 1 ? [staleJwk] : [jwk];
      return Promise.resolve(new Response(JSON.stringify({ keys }), { status: 200 }));
    });

    const result = await verifyCloudflareAccessJwt(jwt, config);
    expect(result).toEqual({ kind: "user", email: "user@sentry.io" });
  });

  it("returns null when signature is invalid", async () => {
    const { jwt } = await makeValidJwt();
    const otherKeyPair = await generateKeyPair();
    const otherJwk = await crypto.subtle.exportKey("jwk", otherKeyPair.publicKey);
    (otherJwk as Record<string, unknown>).kid = "test-kid";
    mockCertsEndpoint(otherJwk);

    expect(await verifyCloudflareAccessJwt(jwt, config)).toBeNull();
  });

  it.each([
    ["the certs fetch throws", () => Promise.reject(new Error("network down"))],
    ["the certs endpoint answers 500", () => Promise.resolve(new Response("Internal Server Error", { status: 500 }))],
    ["the certs response has no keys array", () => Promise.resolve(Response.json({}))],
    ["the certs response has an empty keys array", () => Promise.resolve(Response.json({ keys: [] }))],
    ["the certs response keys is not an array", () => Promise.resolve(Response.json({ keys: "not-an-array" }))],
  ])("fails closed (returns null, does not throw) when %s", async (_case, certs) => {
    const { jwt } = await makeValidJwt();
    vi.spyOn(globalThis, "fetch").mockImplementation(certs as () => Promise<Response>);

    await expect(verifyCloudflareAccessJwt(jwt, config)).resolves.toBeNull();
  });

  // Algorithm confusion: a token must not choose a weaker check than the RS256 one we run.
  it.each([
    ["alg none", { alg: "none" }],
    ["alg HS256", { alg: "HS256" }],
  ])("returns null for a token with %s", async (_case, header) => {
    const { jwt, jwk } = await makeValidJwt({ header });
    mockCertsEndpoint(jwk);

    expect(await verifyCloudflareAccessJwt(jwt, config)).toBeNull();
  });

  it("returns null for a token without exp", async () => {
    const { jwt, jwk } = await makeValidJwt({ payload: { exp: undefined } });
    mockCertsEndpoint(jwk);

    expect(await verifyCloudflareAccessJwt(jwt, config)).toBeNull();
  });

  // For any address: accepted if and only if it ends in "@" plus an allowed domain, so
  // lookalikes such as sentry.io.evil.com, evilsentry.io and a second "@" never pass.
  it("accepts an email exactly when its domain is allowed", async () => {
    const { keyPair, jwk } = await makeValidJwt();
    mockCertsEndpoint(jwk);
    const domain = fc.constantFrom("sentry.io", "sentry.io.evil.com", "evilsentry.io", "SENTRY.IO", "evil.com", "sub.sentry.io");
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[a-z0-9.@+-]{1,12}$/), domain, async (local, host) => {
        const email = `${local}@${host}`;
        const jwt = await signJwt(
          { alg: "RS256", kid: "test-kid" },
          { email, aud: [AUD], iss: TEAM_DOMAIN, exp: Math.floor(Date.now() / 1000) + 3600 },
          keyPair.privateKey,
        );
        const identity = await verifyCloudflareAccessJwt(jwt, config);
        expect(identity !== null).toBe(email.toLowerCase().endsWith("@sentry.io"));
      }),
      { numRuns: 60 },
    );
  });

  it("parseAllowedEmailDomains normalizes and defaults", () => {
    expect(parseAllowedEmailDomains(undefined)).toEqual(["sentry.io"]);
    expect(parseAllowedEmailDomains("")).toEqual(["sentry.io"]);
    expect(parseAllowedEmailDomains("  ")).toEqual(["sentry.io"]);
    expect(parseAllowedEmailDomains("@acme.com")).toEqual(["acme.com"]);
    expect(parseAllowedEmailDomains("Acme.com, @Contractors.Acme.com")).toEqual([
      "acme.com",
      "contractors.acme.com",
    ]);
  });

  it("parseAllowedServiceTokenIds normalizes and fails closed by default", () => {
    expect(parseAllowedServiceTokenIds(undefined)).toEqual([]);
    expect(parseAllowedServiceTokenIds("")).toEqual([]);
    expect(parseAllowedServiceTokenIds(" , ")).toEqual([]);
    expect(parseAllowedServiceTokenIds("a.access, b.access")).toEqual([
      "a.access",
      "b.access",
    ]);
  });

  it("accepts an allowlisted service token (common_name, no email)", async () => {
    const { jwt, jwk } = await makeValidJwt({
      payload: { email: undefined, common_name: "svc123.access" },
    });
    mockCertsEndpoint(jwk);

    const serviceConfig: AccessConfig = {
      ...config,
      allowedServiceTokenIds: ["svc123.access"],
    };
    expect(await verifyCloudflareAccessJwt(jwt, serviceConfig)).toEqual({
      kind: "service",
      clientId: "svc123.access",
    });
  });

  it("rejects a service token that is not allowlisted (fail closed)", async () => {
    const { jwt, jwk } = await makeValidJwt({
      payload: { email: undefined, common_name: "svc123.access" },
    });
    mockCertsEndpoint(jwk);

    // No allowlist configured at all, and an allowlist naming a different token.
    expect(await verifyCloudflareAccessJwt(jwt, config)).toBeNull();
    expect(
      await verifyCloudflareAccessJwt(jwt, {
        ...config,
        allowedServiceTokenIds: ["other.access"],
      }),
    ).toBeNull();
  });

  it("still applies the email-domain gate when a service-token allowlist is configured", async () => {
    // An email identity must never slip through via the service-token path.
    const { jwt, jwk } = await makeValidJwt({
      payload: { email: "hacker@evil.com", common_name: "svc123.access" },
    });
    mockCertsEndpoint(jwk);

    expect(
      await verifyCloudflareAccessJwt(jwt, {
        ...config,
        allowedServiceTokenIds: ["svc123.access"],
      }),
    ).toBeNull();
  });

  it("fails closed when the cache is stale and the JWKS refresh fails (no stale-key fallback)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const { jwt, jwk } = await makeValidJwt();
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }),
      );

      // Prime the cache with a successful fetch.
      expect(await verifyCloudflareAccessJwt(jwt, config)).toEqual({
        kind: "user",
        email: "user@sentry.io",
      });

      // Move past the 5-minute cache TTL, then make the JWKS endpoint unreachable.
      vi.advanceTimersByTime(6 * 60 * 1000);
      fetchSpy.mockRejectedValue(new Error("jwks unreachable"));

      // The token is still unexpired, but stale keys must NOT be used — reject.
      expect(await verifyCloudflareAccessJwt(jwt, config)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches certs across calls", async () => {
    const { jwt, jwk } = await makeValidJwt();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })),
    );

    await verifyCloudflareAccessJwt(jwt, config);
    await verifyCloudflareAccessJwt(jwt, config);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("MCP Worker entry", () => {
  it("allows the modern protocol headers in CORS preflights", async () => {
    const response = await workerFetch(new Request("https://test.local/mcp", {
      method: "OPTIONS",
      headers: { Origin: "https://client.example" },
    }));

    expect(response.status).toBe(204);
    const allowed = response.headers.get("Access-Control-Allow-Headers") ?? "";
    expect(allowed).toContain("Mcp-Method");
    expect(allowed).toContain("Mcp-Name");
    expect(allowed).toContain("MCP-Protocol-Version");
    expect(allowed).not.toContain("Mcp-Session-Id");
    expect(response.headers.get("Access-Control-Expose-Headers"))
      .toBe("WWW-Authenticate");
  });

  it("returns a bearer challenge for BYOK authentication failures", async () => {
    const missing = await workerFetch(new Request("https://test.local/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    expect(missing.status).toBe(401);
    expect(missing.headers.get("WWW-Authenticate"))
      .toBe('Bearer realm="plausible-mcp", error="invalid_request"');

    const tooShort = await workerFetch(new Request("https://test.local/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer short",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    expect(tooShort.status).toBe(401);
    expect(tooShort.headers.get("WWW-Authenticate"))
      .toBe('Bearer realm="plausible-mcp", error="invalid_token"');
  });

  it("answers a malformed JSON body with a JSON-RPC parse error, not a 500", async () => {
    const response = await workerFetch(new Request("https://test.local/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer test-key-123",
        "Content-Type": "application/json",
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"broken":',
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32700 } });
  });

  const byokKey = { Authorization: "Bearer test-key-123" };
  it.each([
    ["an unlisted Host", "/mcp", { ...byokKey, Host: "evil.example" }, {}, 403],
    ["an opaque Origin", "/mcp", { ...byokKey, Origin: "null" }, {}, 403],
    // /mcp is open to any browser origin; the key is what authenticates it.
    ["a browser Origin without a key", "/mcp", { Origin: "https://browser.example" }, {}, 401],
    ["an unlisted browser Origin on /internal", "/internal", { Origin: "https://browser.example" }, {}, 403],
    ["a non-JSON media type", "/mcp", { ...byokKey, "Content-Type": "text/plain; note=application/json" }, {}, 415],
    ["no allowed hostnames configured", "/mcp", byokKey, { MCP_ALLOWED_HOSTNAMES: " " }, 500],
  ])("answers a request with %s", async (_case, path, headers, envOverride, status) => {
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
    const makeTransport = () => new StreamableHTTPClientTransport(
      new URL("https://test.local/mcp"),
      {
        requestInit: { headers: { Authorization: "Bearer test-key-123" } },
        fetch: (url, init) => workerFetch(new Request(url, init)),
      },
    );
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
        const expected = tool.name === "send_feedback"
          ? { resourceUri: uri, visibility: ["model"] }
          : { resourceUri: uri };
        expect(tool._meta?.ui).toEqual(expected);
      }
      const resource = await modern.readResource({ uri });
      expect(resource).toMatchObject({
        ttlMs: 3_600_000,
        cacheScope: "public",
        contents: [{ uri, mimeType, _meta: { ui: { prefersBorder: true } }, text: expect.stringContaining("ui/initialize") }],
      });

      await legacy.connect(makeTransport());
      expect(legacy.getProtocolEra()).toBe("legacy");
      expect((await legacy.listTools()).tools).toHaveLength(5);
    } finally {
      await modern.close();
      await legacy.close();
    }
  });

  it("keeps Sentry tool spans and recordToolIO gating on modern requests", async () => {
    clearCertsCache();
    const { jwt, jwk } = await makeValidJwt();
    const envelopes: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (url.pathname === "/cdn-cgi/access/certs") {
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      }
      if (url.hostname === "plausible.io") {
        return new Response(JSON.stringify({
          results: [{ dimensions: ["2026-07-30"], metrics: [10, 20, 30, 40] }],
          meta: {},
          query: {},
        }), { status: 200 });
      }
      if (url.hostname === "sentry.example") {
        envelopes.push(await request.text());
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected fetch in test: ${request.url}`);
    });

    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as ExecutionContext;
    const env = {
      ...WORKER_ENV,
      PLAUSIBLE_API_KEY: "shared-test-key",
      SENTRY_DSN: "https://public@sentry.example/1",
    } satisfies Env;
    const transport = new StreamableHTTPClientTransport(
      new URL("https://test.local/internal"),
      {
        requestInit: { headers: { "Cf-Access-Jwt-Assertion": jwt } },
        fetch: (url, init) => {
          const request = new Request(url, init);
          request.headers.set("Host", new URL(request.url).host);
          return instrumentedWorker.fetch!(request, env, ctx);
        },
      },
    );
    const client = new Client(
      { name: "sentry-modern-test", version: "0.0.1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );

    try {
      await client.connect(transport);
      await client.callTool({
        name: "get_timeseries",
        arguments: { site_id: "example.com", date_range: "7d" },
      });
    } finally {
      await client.close();
    }

    for (let index = 0; index < pending.length; index++) {
      await pending[index];
    }
    const recorded = envelopes.join("\n");
    const internalSpans = exportedSpans(envelopes);
    expect(internalSpans.map((span) => span["sentry.op"])).toEqual(
      expect.arrayContaining(["mcp.server", "http.server"]),
    );
    expect(internalSpans.some((span) => span.is_segment)).toBe(true);
    expect(recorded).not.toContain('"type":"transaction"');
    expect(internalSpans).toContainEqual(expect.objectContaining({
      "mcp.method.name": "tools/call",
      "mcp.client.name": "sentry-modern-test",
      "mcp.request.argument.site_id": '"example.com"',
    }));
    expect(internalSpans.some((span) => "mcp.tool.result.content" in span)).toBe(true);
    // Positive control for the anonymous checks below: /internal does attribute the caller.
    expect(internalSpans).toContainEqual(expect.objectContaining({ "user.email": "user@sentry.io" }));
    expect(recorded).not.toContain(jwt);
    expect(recorded).not.toContain("shared-test-key");

    envelopes.length = 0;
    pending.length = 0;
    const byokTransport = new StreamableHTTPClientTransport(
      new URL("https://test.local/mcp?subject=query-canary-456"),
      {
        requestInit: {
          headers: {
            Authorization: "Bearer private-test-key",
            // Stands in for the client-identity headers real callers send. It matches
            // none of the SDK's sensitive-key snippets, so nothing upstream filters it.
            "X-Openai-Subject": "subject-canary-123",
            "User-Agent": "ua-canary-789",
          },
        },
        fetch: (url, init) => {
          const request = new Request(url, init);
          request.headers.set("Host", new URL(request.url).host);
          return instrumentedWorker.fetch!(request, env, ctx);
        },
      },
    );
    const byokClient = new Client(
      { name: "sentry-byok-test", version: "0.0.1", title: "title-canary-abc" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await byokClient.connect(byokTransport);
      await byokClient.callTool({
        name: "get_timeseries",
        arguments: { site_id: "private.example", date_range: "7d" },
      });
      // Feedback events bypass beforeSend entirely, so they exercise a different
      // redaction path than the tool call above.
      await byokClient.callTool({
        name: "send_feedback",
        arguments: {
          task: "Check weekly traffic",
          kind: "confusing",
          impact: "friction",
          description: "The error for key private-test-key was not specific enough.",
        },
      });
    } finally {
      await byokClient.close();
    }
    // A legacy client sends clientInfo through the initialize handshake, which the Sentry
    // SDK stores per transport and turns into mcp.client.* attributes on its own — a
    // different source than recordMcpClientInfo, which reads the modern _meta envelope.
    const legacyTransport = new StreamableHTTPClientTransport(
      new URL("https://test.local/mcp"),
      {
        requestInit: { headers: { Authorization: "Bearer private-test-key" } },
        fetch: (url, init) => {
          const request = new Request(url, init);
          request.headers.set("Host", new URL(request.url).host);
          return instrumentedWorker.fetch!(request, env, ctx);
        },
      },
    );
    const legacyClient = new Client({
      name: "legacy-canary@example.com",
      version: "0.0.1",
      title: "title-canary-abc",
    });
    try {
      await legacyClient.connect(legacyTransport);
      await legacyClient.callTool({
        name: "get_timeseries",
        arguments: { site_id: "private.example", date_range: "7d" },
      });
    } finally {
      await legacyClient.close();
    }
    for (let index = 0; index < pending.length; index++) {
      await pending[index];
    }
    const anonymous = envelopes.join("\n");
    const anonymousSpans = exportedSpans(envelopes);
    expect(anonymousSpans.some((span) => span["mcp.method.name"] === "tools/call")).toBe(true);
    expect(anonymous).not.toContain("mcp.request.argument.site_id");
    expect(anonymous).not.toContain('"mcp.tool.result.content":');
    expect(anonymous).not.toContain("private.example");
    expect(anonymous).not.toContain("private-test-key");
    // mcp.client.name/version are recorded on both endpoints — a client library
    // name and version identify software, not the person using it.
    expect(anonymousSpans.some((span) => span["mcp.client.name"] === "sentry-byok-test")).toBe(true);
    // Positive control: the feedback submission really did reach the transport, so the
    // canary assertions below are checking a populated envelope rather than an empty one.
    expect(anonymous).toContain("send_feedback");
    expect(anonymous).not.toContain("subject-canary-123");
    expect(anonymous).not.toContain("x_openai_subject");
    expect(anonymous).not.toContain("query-canary-456");
    expect(anonymous).not.toContain("ua-canary-789");
    // The SDK writes mcp.client.title from the transport's own clientInfo, independently
    // of recordMcpClientInfo, so suppressing it at the source is not enough.
    expect(anonymous).not.toContain("title-canary-abc");
    // mcp.client.name is kept, but sanitizeClientAttribute replaces a value shaped like a
    // person rather than a piece of software — including on the SDK's own write path.
    expect(anonymous).not.toContain("legacy-canary@example.com");
    expect(anonymousSpans.some((span) => span["mcp.client.name"] === "[redacted]")).toBe(true);
    // The SDK derives no user.* here today, so this guards a future SDK change; the
    // stripping itself is covered by redaction.test.ts "anonymizeSpanWithoutIdentity".
    expect(anonymousSpans.flatMap((span) => Object.keys(span).filter((key) => key.startsWith("user.")))).toEqual([]);
  });

  it("samples heartbeat spans at the keep-rate and keeps tool calls, with or without Mcp-Method", async () => {
    clearCertsCache();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const envelopes: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === "plausible.io") {
        return new Response(JSON.stringify({
          results: [{ dimensions: ["2026-07-30"], metrics: [10, 20, 30, 40] }],
          meta: {},
          query: {},
        }), { status: 200 });
      }
      if (url.hostname === "sentry.example") {
        envelopes.push(await request.text());
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected fetch in test: ${request.url}`);
    });

    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as ExecutionContext;
    const env = {
      ...WORKER_ENV,
      PLAUSIBLE_API_KEY: "shared-test-key",
      SENTRY_DSN: "https://public@sentry.example/1",
    } satisfies Env;

    // Every POST below needs Accept (or the MCP transport 406s before dispatch) and an
    // explicit Content-Length (the test runtime does not compute one for us), since
    // withMcpMethodHeader and inspectMcpRequest both key off that header.
    const mcpPost = (body: unknown, extraHeaders: Record<string, string> = {}): Request => {
      const bodyText = JSON.stringify(body);
      return new Request("https://test.local/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer private-test-key",
          Host: "test.local",
          "Content-Length": String(new TextEncoder().encode(bodyText).length),
          ...extraHeaders,
        },
        body: bodyText,
      });
    };

    // Sends one request, drains ctx.waitUntil, and returns the envelopes it flushed —
    // resetting both so the next request in this test starts from a clean slate.
    const sendAndFlush = async (request: Request): Promise<string[]> => {
      await (await instrumentedWorker.fetch!(request, env, ctx)).text();
      for (const promise of pending) await promise;
      const flushed = [...envelopes];
      envelopes.length = 0;
      pending.length = 0;
      return flushed;
    };

    try {
      const pingEnvelope = await sendAndFlush(
        mcpPost({ jsonrpc: "2.0", id: 1, method: "ping" }, { "Mcp-Method": "ping" }),
      );
      expect(exportedSpans(pingEnvelope)).toEqual([]);

      // Legacy client: no Mcp-Method header at all — proves withMcpMethodHeader.
      const legacyPingEnvelope = await sendAndFlush(
        mcpPost({ jsonrpc: "2.0", id: 1, method: "ping" }),
      );
      expect(exportedSpans(legacyPingEnvelope)).toEqual([]);

      // Legacy client calling a real tool: still classified and sampled at 100%.
      const legacyToolEnvelope = await sendAndFlush(
        mcpPost({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "get_timeseries",
            arguments: { site_id: "example.com", date_range: "7d" },
          },
        }),
      );
      const legacyToolSpans = exportedSpans(legacyToolEnvelope);
      expect(legacyToolSpans.some((span) => span["mcp.method.name"] === "tools/call")).toBe(true);
      expect(legacyToolSpans.some((span) => span.is_segment)).toBe(true);

      // Below the keep-rate, the same legacy ping is kept: it is sampled, not dropped.
      randomSpy.mockReturnValue(HEARTBEAT_SPAN_KEEP_RATE / 2);
      const keptPingEnvelope = await sendAndFlush(
        mcpPost({ jsonrpc: "2.0", id: 2, method: "ping" }),
      );
      expect(exportedSpans(keptPingEnvelope)).toContainEqual(
        expect.objectContaining({ "mcp.method.name": "ping" }),
      );
    } finally {
      randomSpy.mockRestore();
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
  it("applies the existing rate limiter to the public page", async () => {
    const response = await workerFetch(new Request("https://test.local/"), {
      ...env, RATE_LIMITER: {limit: async () => ({success: false})},
    });
    expect(response.status).toBe(429);
  });
});

/**
 * Stands in for everything the Worker reaches over the network: the Access JWKS, Plausible
 * (recording the Authorization header each query carries) and a Sentry ingest host.
 */
function stubUpstream(jwk?: JsonWebKey) {
  const plausibleAuth: string[] = [];
  const envelopes: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/cdn-cgi/access/certs" && jwk) return Response.json({ keys: [jwk] });
    if (url.hostname === "plausible.io") {
      plausibleAuth.push(request.headers.get("Authorization") ?? "");
      return Response.json({ results: [{ dimensions: ["2026-07-30"], metrics: [1, 2, 3, 4] }], meta: {}, query: {} });
    }
    if (url.hostname === "sentry.example") {
      envelopes.push(await request.text());
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${request.url}`);
  });
  return { plausibleAuth, envelopes };
}

function workerClient(path: string, headers: Record<string, string>, env: Env = WORKER_ENV) {
  const transport = new StreamableHTTPClientTransport(new URL(`https://test.local${path}`), {
    requestInit: { headers },
    fetch: (url, init) => workerFetch(new Request(url, init), env),
  });
  const client = new Client({ name: "worker-e2e", version: "0.0.1" });
  return { client, connect: () => client.connect(transport) };
}

const timeseries = { name: "get_timeseries", arguments: { site_id: "example.com", date_range: "7d" } };

function toolsList(path: string, headers: Record<string, string>) {
  return new Request(`https://test.local${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

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
    } as Env);

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
  it("reports a failure inside the MCP handler to Sentry and answers a JSON-RPC error", async () => {
    const upstream = stubUpstream();
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
    const env = {
      ...WORKER_ENV,
      PLAUSIBLE_BASE_URL: "http://plausible.example",
      SENTRY_DSN: "https://public@sentry.example/1",
    } satisfies Env;
    const request = toolsList("/mcp", { Authorization: "Bearer key-aaaa-1111", Host: "test.local" });

    const response = await instrumentedWorker.fetch!(request, env, ctx);
    for (let i = 0; i < pending.length; i++) await pending[i];

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: -32603 } });
    const events = upstream.envelopes.filter((envelope) => envelope.includes('"type":"event"'));
    expect(events.join("\n")).toContain("baseUrl must use HTTPS");
    expect(upstream.envelopes.join("\n")).not.toContain("key-aaaa-1111");
  });
});
