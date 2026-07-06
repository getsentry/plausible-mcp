import { describe, it, expect, vi } from "vitest";
import { handleAccessRequest } from "../src/access-handler.js";
import type { Env } from "../src/env.js";

const HOST = "https://plausible-mcp.sentry.dev";
const COOKIE_KEY = "test-cookie-encryption-key-0123456789abcdef";
const CSRF = "csrf-token-123";

const CLIENT_ID = "client-1";
const REGISTERED_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    COOKIE_ENCRYPTION_KEY: COOKIE_KEY,
    ACCESS_CLIENT_ID: "access-client-id",
    ACCESS_CLIENT_SECRET: "access-client-secret",
    ACCESS_AUTHORIZATION_URL: "https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/authorize",
    ACCESS_TOKEN_URL: "https://team.cloudflareaccess.com/cdn-cgi/access/token",
    CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    OAUTH_KV: { put: vi.fn().mockResolvedValue(undefined) } as unknown as KVNamespace,
    OAUTH_PROVIDER: {
      lookupClient: vi.fn().mockResolvedValue({
        clientId: CLIENT_ID,
        redirectUris: [REGISTERED_REDIRECT],
      }),
    } as unknown as Env["OAUTH_PROVIDER"],
    ...overrides,
  } as Env;
}

function postAuthorize(redirectUri: string, host = HOST): Request {
  const oauthReqInfo = {
    clientId: CLIENT_ID,
    redirectUri,
    responseType: "code",
    scope: ["mcp"],
    state: "client-state",
    codeChallenge: "challenge",
    codeChallengeMethod: "S256",
  };
  const encodedState = btoa(JSON.stringify({ oauthReqInfo }));
  const body = new URLSearchParams({ csrf_token: CSRF, state: encodedState });
  return new Request(`${host}/authorize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `__Host-CSRF_TOKEN=${CSRF}`,
    },
    body: body.toString(),
  });
}

const ctx = {} as ExecutionContext;

describe("handleAccessRequest — host guard", () => {
  it("rejects requests to an unexpected host", async () => {
    const res = await handleAccessRequest(
      new Request("https://evil.example/authorize", { method: "GET" }),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Unexpected host");
  });

  it("allows the production custom domain", async () => {
    const res = await handleAccessRequest(
      new Request(`${HOST}/unknown-path`, { method: "GET" }),
      makeEnv(),
      ctx,
    );
    // Passes the host guard; falls through to the 404 for unknown routes.
    expect(res.status).toBe(404);
  });
});

describe("handleAccessRequest — POST /authorize redirect_uri validation", () => {
  it("rejects a redirect_uri not registered to the client (tampered state)", async () => {
    const env = makeEnv();
    const res = await handleAccessRequest(
      postAuthorize("https://attacker.example/steal"),
      env,
      ctx,
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid redirect_uri");
    // Must reject before persisting any OAuth state.
    expect(env.OAUTH_KV.put).not.toHaveBeenCalled();
  });

  it("rejects when the client is unknown", async () => {
    const env = makeEnv({
      OAUTH_PROVIDER: {
        lookupClient: vi.fn().mockResolvedValue(null),
      } as unknown as Env["OAUTH_PROVIDER"],
    });
    const res = await handleAccessRequest(
      postAuthorize(REGISTERED_REDIRECT),
      env,
      ctx,
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid request");
    expect(env.OAUTH_KV.put).not.toHaveBeenCalled();
  });

  it("accepts a registered redirect_uri and redirects to Cloudflare Access", async () => {
    const env = makeEnv();
    const res = await handleAccessRequest(
      postAuthorize(REGISTERED_REDIRECT),
      env,
      ctx,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain(
      "https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/authorize",
    );
    // The redirect_uri sent upstream is our own /callback on the pinned host.
    const upstream = new URL(location);
    expect(upstream.searchParams.get("redirect_uri")).toBe(`${HOST}/callback`);
    expect(upstream.searchParams.get("code_challenge_method")).toBe("S256");
    // State was persisted for the callback to validate.
    expect(env.OAUTH_KV.put).toHaveBeenCalledOnce();
  });

  it("rejects a mismatched CSRF token before touching client lookup", async () => {
    const env = makeEnv();
    const req = new Request(`${HOST}/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `__Host-CSRF_TOKEN=different-token`,
      },
      body: new URLSearchParams({
        csrf_token: CSRF,
        state: btoa(JSON.stringify({ oauthReqInfo: { clientId: CLIENT_ID } })),
      }).toString(),
    });

    const res = await handleAccessRequest(req, env, ctx);
    expect(res.status).toBe(400);
    expect(env.OAUTH_PROVIDER.lookupClient).not.toHaveBeenCalled();
  });
});
