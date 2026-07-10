import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  verifyCloudflareAccessJwt,
  clearCertsCache,
  parseAllowedEmailDomains,
  type AccessConfig,
} from "../src/cf-access.js";

const TEAM_DOMAIN = "https://sentry.cloudflareaccess.com";
const AUD = "test-audience-tag";

const config: AccessConfig = {
  teamDomain: TEAM_DOMAIN,
  aud: AUD,
  allowedEmailDomains: ["sentry.io"],
};

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
