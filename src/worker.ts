import * as Sentry from "@sentry/cloudflare";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp";
import { createServer } from "./server.js";
import { handleAccessRequest } from "./access-handler.js";
import type { Env, Props } from "./env.js";

// @sentry/cloudflare doesn't re-export SpanJSON; derive it from the option type.
type SpanJSON = Parameters<
  NonNullable<Sentry.CloudflareOptions["beforeSendSpan"]>
>[0];

const SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Cache-Control": "no-store",
};

const CORS_HEADERS: Record<string, string> = {
  ...SECURITY_HEADERS,
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Accept, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function corsResponse(response: Response): Response {
  const patched = new Response(response.body, response);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    patched.headers.set(key, value);
  }
  return patched;
}

function jsonError(message: string, status: number): Response {
  return new Response(
    JSON.stringify({ error: message }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function sentryConfig(env: Env) {
  return {
    dsn: "https://de333c4dff86900878d446e663271b2a@o4509446862274560.ingest.us.sentry.io/4511179029020672",
    release: env.SENTRY_RELEASE,
    tracesSampleRate: 1.0,
    sendDefaultPii: false,
    beforeSendSpan(span: SpanJSON): SpanJSON {
      if (span.data) {
        for (const key of Object.keys(span.data)) {
          const lower = key.toLowerCase();
          if (
            lower.includes("authorization") ||
            lower.includes("cookie") ||
            lower.includes("jwt-assertion") || // Cf-Access-Jwt-Assertion
            lower.includes("cf-access")
          ) {
            span.data[key] = "[Filtered]";
          }
        }
      }
      return span;
    },
  };
}

async function rateLimited(request: Request, env: Env): Promise<Response | null> {
  if (!env.RATE_LIMITER) return null;
  const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.RATE_LIMITER.limit({ key: clientIp });
  if (success) return null;
  return new Response(
    JSON.stringify({ error: "Rate limit exceeded. Try again later." }),
    { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60" } },
  );
}

/**
 * OAuth-protected MCP endpoint (`/internal`) for managed connectors (e.g. Cowork).
 * OAuthProvider has already validated the access token; the caller's identity is on
 * `ctx.props`. Queries run against the shared server-side Plausible API key.
 */
const internalMcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as ExecutionContext & { props?: Props }).props;
    if (props?.email) {
      Sentry.setUser({ email: props.email });
    }

    if (!env.PLAUSIBLE_API_KEY) {
      return jsonError("Server misconfigured: missing shared Plausible API key.", 500);
    }

    const server = createServer({
      apiKey: env.PLAUSIBLE_API_KEY,
      baseUrl: env.PLAUSIBLE_BASE_URL,
      defaultSiteId: env.PLAUSIBLE_DEFAULT_SITE_ID,
      recordPii: true,
    });

    return createMcpHandler(server, { route: "/internal" })(request, env, ctx);
  },
};

/**
 * Bring-your-own-key MCP endpoint (`/mcp`) for header-capable clients (Claude Code,
 * Cursor, MCP Inspector). Each caller passes their own Plausible API key as a Bearer
 * token. Unchanged from the original public contract — not OAuth-protected.
 */
async function handleDirectMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  const apiKey = authHeader?.replace(/^Bearer\s+/i, "").trim();

  if (!apiKey) {
    return jsonError(
      "Missing Plausible API key. Pass it as a Bearer token in the Authorization header.",
      401,
    );
  }

  if (apiKey.length < 8) {
    return jsonError("Invalid API key. Key is too short.", 401);
  }

  let server;
  try {
    server = createServer({
      apiKey,
      baseUrl: env.PLAUSIBLE_BASE_URL,
      defaultSiteId: env.PLAUSIBLE_DEFAULT_SITE_ID,
    });
  } catch (error) {
    Sentry.captureException(error);
    return jsonError("Server configuration error.", 500);
  }

  return createMcpHandler(server)(request, env, ctx);
}

/**
 * Handles everything OAuthProvider does not route to the protected apiHandler:
 * the BYOK `/mcp` endpoint, the OAuth authorize/callback federation, and 404s.
 */
async function handleDefault(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
    return handleDirectMcp(request, env, ctx);
  }

  // /authorize and /callback (Cloudflare Access federation)
  return handleAccessRequest(request, env, ctx);
}

const oauthProvider = new OAuthProvider<Env>({
  apiRoute: "/internal",
  apiHandler: internalMcpHandler,
  defaultHandler: { fetch: handleDefault } as unknown as ExportedHandler<Env>,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  // CIMD (URL-based client_ids) is preferred for managed connectors; DCR via
  // /register stays as a fallback so other MCP clients can still self-register.
  clientIdMetadataDocumentEnabled: true,
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["mcp"],
  // OAuth 2.1 hardening: S256-only PKCE (no `plain`), and bound token lifetimes so
  // an offboarded employee can't reuse tokens indefinitely (default refresh = never
  // expires). Access tokens already default to 1h; cap refresh at 24h.
  allowPlainPKCE: false,
  accessTokenTTL: 60 * 60, // 1 hour
  refreshTokenTTL: 24 * 60 * 60, // 24 hours
});

const handler = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const limited = await rateLimited(request, env);
    if (limited) return corsResponse(limited);

    const response = await oauthProvider.fetch(request, env, ctx);
    return corsResponse(response);
  },
} satisfies ExportedHandler<Env>;

export default Sentry.withSentry(sentryConfig, handler);
