import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";
import {
  verifyCloudflareAccessJwt,
  clearCertsCache,
  parseAllowedEmailDomains,
  parseAllowedServiceTokenIds,
  type AccessConfig,
} from "../src/cf-access.js";
import {
  AUD,
  config,
  generateKeyPair,
  makeValidJwt,
  mockCertsEndpoint,
  signJwt,
  TEAM_DOMAIN,
} from "./worker-fixtures.js";

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
    mockCertsEndpoint({ ...jwk, kid: "different-kid" });

    expect(await verifyCloudflareAccessJwt(jwt, config)).toBeNull();
  });

  it("refreshes certs on kid miss and succeeds with rotated key", async () => {
    const { jwt, jwk } = await makeValidJwt();
    const staleJwk = { ...jwk, kid: "old-kid" };
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
    mockCertsEndpoint({ ...otherJwk, kid: "test-kid" });

    expect(await verifyCloudflareAccessJwt(jwt, config)).toBeNull();
  });

  it.each([
    ["the certs fetch throws", () => Promise.reject(new Error("network down"))],
    [
      "the certs endpoint answers 500",
      () => Promise.resolve(new Response("Internal Server Error", { status: 500 })),
    ],
    ["the certs response has no keys array", () => Promise.resolve(Response.json({}))],
    [
      "the certs response has an empty keys array",
      () => Promise.resolve(Response.json({ keys: [] })),
    ],
    [
      "the certs response keys is not an array",
      () => Promise.resolve(Response.json({ keys: "not-an-array" })),
    ],
  ])("fails closed (returns null, does not throw) when %s", async (_case, certs) => {
    const { jwt } = await makeValidJwt();
    vi.spyOn(globalThis, "fetch").mockImplementation(certs);

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
    const domain = fc.constantFrom(
      "sentry.io",
      "sentry.io.evil.com",
      "evilsentry.io",
      "SENTRY.IO",
      "evil.com",
      "sub.sentry.io",
    );
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
    expect(parseAllowedServiceTokenIds("a.access, b.access")).toEqual(["a.access", "b.access"]);
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
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }));

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
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })),
      );

    await verifyCloudflareAccessJwt(jwt, config);
    await verifyCloudflareAccessJwt(jwt, config);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
