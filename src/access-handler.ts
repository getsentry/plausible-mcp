import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { verifyCloudflareAccessJwt } from "./cf-access.js";
import type { Env, Props } from "./env.js";
import {
  addApprovedClient,
  createOAuthState,
  fetchUpstreamAuthToken,
  generateCSRFProtection,
  getUpstreamAuthorizeUrl,
  isClientApproved,
  OAuthError,
  renderApprovalDialog,
  validateCSRFToken,
  validateOAuthState,
} from "./workers-oauth-utils.js";

const SERVER_INFO = {
  name: "Plausible Analytics MCP",
  description:
    "Query Plausible Analytics traffic and conversion data. Sentry SSO (Cloudflare Access) is required to connect.",
};

/**
 * Implements the MCP client-facing OAuth authorize/callback endpoints, federating
 * the actual login to Cloudflare Access (configured as an upstream OIDC provider).
 *
 * Flow:
 *   1. MCP client → GET /authorize  → (consent) → redirect to Access /authorize
 *   2. Access → GET /callback?code  → exchange code, verify id_token, gate on @sentry.io
 *   3. completeAuthorization → mint our own token → redirect back to the MCP client
 *
 * Token + grant storage, discovery metadata, /token and /register are handled by
 * @cloudflare/workers-oauth-provider; this only owns /authorize and /callback.
 */
export async function handleAccessRequest(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const { pathname, searchParams } = new URL(request.url);

  if (request.method === "GET" && pathname === "/authorize") {
    const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    const { clientId } = oauthReqInfo;
    if (!clientId) {
      return new Response("Invalid request", { status: 400 });
    }

    // Skip the consent screen for clients the user already approved on this device.
    if (await isClientApproved(request, clientId, env.COOKIE_ENCRYPTION_KEY)) {
      const { stateToken, codeChallenge } = await createOAuthState(
        oauthReqInfo,
        env.OAUTH_KV,
        env.COOKIE_ENCRYPTION_KEY,
      );
      return redirectToAccess(request, env, stateToken, codeChallenge);
    }

    const { token: csrfToken, setCookie } = generateCSRFProtection();
    return renderApprovalDialog(request, {
      client: await env.OAUTH_PROVIDER.lookupClient(clientId),
      csrfToken,
      server: SERVER_INFO,
      setCookie,
      state: { oauthReqInfo },
    });
  }

  if (request.method === "POST" && pathname === "/authorize") {
    try {
      const formData = await request.formData();
      const csrfResult = validateCSRFToken(formData, request);

      const encodedState = formData.get("state");
      if (!encodedState || typeof encodedState !== "string") {
        return new Response("Missing state in form data", { status: 400 });
      }

      let state: { oauthReqInfo?: AuthRequest };
      try {
        state = JSON.parse(atob(encodedState));
      } catch (_e) {
        return new Response("Invalid state data", { status: 400 });
      }

      if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
        return new Response("Invalid request", { status: 400 });
      }

      const approvedClientCookie = await addApprovedClient(
        request,
        state.oauthReqInfo.clientId,
        env.COOKIE_ENCRYPTION_KEY,
      );
      const { stateToken, codeChallenge } = await createOAuthState(
        state.oauthReqInfo,
        env.OAUTH_KV,
        env.COOKIE_ENCRYPTION_KEY,
      );

      const redirectHeaders = new Headers();
      redirectHeaders.append("Set-Cookie", approvedClientCookie);
      redirectHeaders.append("Set-Cookie", csrfResult.clearCookie);
      return redirectToAccess(request, env, stateToken, codeChallenge, redirectHeaders);
    } catch (error) {
      if (error instanceof OAuthError) {
        return error.toResponse();
      }
      return new Response("Internal server error", { status: 500 });
    }
  }

  if (request.method === "GET" && pathname === "/callback") {
    let oauthReqInfo: AuthRequest;
    let codeVerifier: string;
    try {
      const result = await validateOAuthState(
        request,
        env.OAUTH_KV,
        env.COOKIE_ENCRYPTION_KEY,
      );
      oauthReqInfo = result.oauthReqInfo;
      codeVerifier = result.codeVerifier;
    } catch (error) {
      if (error instanceof OAuthError) {
        return error.toResponse();
      }
      return new Response("Internal server error", { status: 500 });
    }

    if (!oauthReqInfo.clientId) {
      return new Response("Invalid OAuth request data", { status: 400 });
    }

    const [, idToken, errResponse] = await fetchUpstreamAuthToken({
      client_id: env.ACCESS_CLIENT_ID,
      client_secret: env.ACCESS_CLIENT_SECRET,
      code: searchParams.get("code") ?? undefined,
      code_verifier: codeVerifier,
      redirect_uri: new URL("/callback", request.url).href,
      upstream_url: env.ACCESS_TOKEN_URL,
    });
    if (errResponse) {
      return errResponse;
    }

    // Reuse the same JWKS-based verifier as the legacy CF Access path: the id_token
    // is signed by the team's /cdn-cgi/access/certs, its `aud` is our OIDC client_id,
    // its `iss` is the team domain, and the email must be @sentry.io.
    const identity = await verifyCloudflareAccessJwt(idToken, {
      teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
      aud: env.ACCESS_CLIENT_ID,
    });
    if (!identity) {
      return new Response("Forbidden: a valid @sentry.io identity is required.", {
        status: 403,
      });
    }

    // Keep plaintext PII out of the (unencrypted) grant store: the OAuth `userId`
    // and `metadata` are persisted in KV in the clear, so derive a stable opaque
    // id from the email instead. The real email lives only in `props`, which the
    // provider encrypts, and is what we use for Sentry attribution.
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      metadata: {}, // intentionally empty — no plaintext PII in the unencrypted grant
      props: { email: identity.email } satisfies Props,
      request: oauthReqInfo,
      scope: oauthReqInfo.scope,
      userId: await sha256Hex(identity.email),
    });
    return Response.redirect(redirectTo, 302);
  }

  return new Response("Not Found", { status: 404 });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function redirectToAccess(
  request: Request,
  env: Env,
  stateToken: string,
  codeChallenge: string,
  extraHeaders: Headers = new Headers(),
): Promise<Response> {
  const headers = new Headers(extraHeaders);
  headers.set(
    "location",
    getUpstreamAuthorizeUrl({
      client_id: env.ACCESS_CLIENT_ID,
      code_challenge: codeChallenge,
      redirect_uri: new URL("/callback", request.url).href,
      scope: "openid email profile",
      state: stateToken,
      upstream_url: env.ACCESS_AUTHORIZATION_URL,
    }),
  );
  return new Response(null, { headers, status: 302 });
}
