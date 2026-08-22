import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  verifyCloudflareAccessJwt,
  clearCertsCache,
  parseAllowedEmailDomains,
  type AccessConfig,
} from "../src/cf-access.js";
import instrumentedWorker, { workerHandler } from "../src/worker.js";
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

  it("fails closed (returns null) when the certs fetch itself throws", async () => {
    const { jwt } = await makeValidJwt();
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.reject(new Error("network down")),
    );

    await expect(verifyCloudflareAccessJwt(jwt, config)).resolves.toBeNull();
  });

  it("returns email for a valid JWT", async () => {
    const { jwt, jwk } = await makeValidJwt();
    mockCertsEndpoint(jwk);

    const result = await verifyCloudflareAccessJwt(jwt, config);
    expect(result).toEqual({ email: "user@sentry.io" });
  });

  it("returns the lowercased email so attribution is stable", async () => {
    const { jwt, jwk } = await makeValidJwt({
      payload: { email: "User.Name@Sentry.IO" },
    });
    mockCertsEndpoint(jwk);

    expect(await verifyCloudflareAccessJwt(jwt, config)).toEqual({
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

    expect(await verifyCloudflareAccessJwt(jwt, config)).toEqual({ email: "user@sentry.io" });
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
    expect(result).toEqual({ email: "user@sentry.io" });
  });

  it("returns null when signature is invalid", async () => {
    const { jwt } = await makeValidJwt();
    const otherKeyPair = await generateKeyPair();
    const otherJwk = await crypto.subtle.exportKey("jwk", otherKeyPair.publicKey);
    (otherJwk as Record<string, unknown>).kid = "test-kid";
    mockCertsEndpoint(otherJwk);

    expect(await verifyCloudflareAccessJwt(jwt, config)).toBeNull();
  });

  it("returns null when certs endpoint fails", async () => {
    const { jwt } = await makeValidJwt();
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 })),
    );

    expect(await verifyCloudflareAccessJwt(jwt, config)).toBeNull();
  });

  it("returns null when certs response has no keys array", async () => {
    const { jwt } = await makeValidJwt();
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    );

    expect(await verifyCloudflareAccessJwt(jwt, config)).toBeNull();
  });

  it("returns null when certs response has empty keys array", async () => {
    const { jwt } = await makeValidJwt();
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ keys: [] }), { status: 200 })),
    );

    expect(await verifyCloudflareAccessJwt(jwt, config)).toBeNull();
  });

  it("returns null when certs response keys is not an array", async () => {
    const { jwt } = await makeValidJwt();
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ keys: "not-an-array" }), { status: 200 })),
    );

    expect(await verifyCloudflareAccessJwt(jwt, config)).toBeNull();
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

  it("fails closed when the cache is stale and the JWKS refresh fails (no stale-key fallback)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const { jwt, jwk } = await makeValidJwt();
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }),
      );

      // Prime the cache with a successful fetch.
      expect(await verifyCloudflareAccessJwt(jwt, config)).toEqual({ email: "user@sentry.io" });

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

  it("rejects invalid hosts, opaque origins, and non-JSON media types", async () => {
    const invalidHost = await workerFetch(new Request("https://test.local/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key-123",
        "Content-Type": "application/json",
        Host: "evil.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    expect(invalidHost.status).toBe(403);

    const opaqueOrigin = await workerFetch(new Request("https://test.local/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key-123",
        "Content-Type": "application/json",
        Origin: "null",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    expect(opaqueOrigin.status).toBe(403);

    const openByokOrigin = await workerFetch(new Request("https://test.local/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://browser.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    expect(openByokOrigin.status).toBe(401);

    const unapprovedInternalOrigin = await workerFetch(
      new Request("https://test.local/internal", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://browser.example",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(unapprovedInternalOrigin.status).toBe(403);

    const wrongMediaType = await workerFetch(new Request("https://test.local/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer test-key-123",
        "Content-Type": "text/plain; note=application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    expect(wrongMediaType.status).toBe(415);
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
      expect((await modern.listTools()).tools).toHaveLength(5);

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
    expect(recorded).toContain('"mcp.method.name":"tools/call"');
    expect(recorded).toContain('"mcp.client.name":"sentry-modern-test"');
    expect(recorded).toContain('"mcp.request.argument.site_id":"\\"example.com\\""');
    expect(recorded).toContain('"mcp.tool.result.content":');
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
      // Feedback events bypass beforeSend/beforeSendTransaction, so they exercise a
      // different redaction path than the tool call above.
      await byokClient.callTool({
        name: "send_feedback",
        arguments: { message: "The error message was not specific enough." },
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
      name: "sentry-legacy-test",
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
    expect(anonymous).toContain('"mcp.method.name":"tools/call"');
    expect(anonymous).not.toContain("mcp.request.argument.site_id");
    expect(anonymous).not.toContain('"mcp.tool.result.content":');
    expect(anonymous).not.toContain("private.example");
    expect(anonymous).not.toContain("private-test-key");
    // mcp.client.name/version are recorded on both endpoints — a client library
    // name and version identify software, not the person using it.
    expect(anonymous).toContain('"mcp.client.name":"sentry-byok-test"');
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
  });
});
