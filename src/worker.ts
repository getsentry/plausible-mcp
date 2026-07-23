import * as Sentry from "@sentry/cloudflare";
import { createMcpHandler } from "agents/mcp";
import { createServer } from "./server.js";
import { parseAllowedEmailDomains, verifyCloudflareAccessJwt } from "./cf-access.js";
import { anonymizeEventWithoutEmail } from "./redaction.js";
import {
  classifyMcpRequest,
  classifyRoute,
  errorDropReason,
  resolveClientFamily,
  statusClass,
  traceSampleValue,
  transactionDropReason,
  type McpRequestTelemetry,
  type TrackedRoute,
} from "./telemetry.js";
import type { Env } from "./env.js";

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

function sentryConfig(env: Env): Sentry.CloudflareOptions {
  return {
    // Set out-of-band (`wrangler secret put SENTRY_DSN`), never hardcoded: this repo is
    // public and forks deploy it as-is, so a baked-in DSN makes every third-party
    // deployment report into the DSN owner's Sentry project. Unset disables the SDK.
    dsn: env.SENTRY_DSN,
    release: env.SENTRY_RELEASE,
    tracesSampleRate: 1.0,
    sendDefaultPii: false,
    // Count traffic in cheap, bounded metrics (see recordResponseMetric) instead of
    // reading volume off 100%-sampled spans. This is what lets beforeSendTransaction
    // drop scanner/keepalive spans below without losing uptime/volume dashboards.
    enableMetrics: true,
    // BYOK (`/mcp`) privacy guardrail: only `/internal` sets an identity via Sentry.setUser.
    // Strip the ingest-inferred client IP from every other (anonymous) event so BYOK traffic
    // carries tool names and failures, never who made them. See ./redaction.ts.
    beforeSend(event) {
      anonymizeEventWithoutEmail(event);
      if (errorDropReason(event)) return null;
      return event;
    },
    beforeSendTransaction(event) {
      anonymizeEventWithoutEmail(event);
      // Drop transaction spans that are pure noise: internet scanners hitting
      // untracked routes, and all but a thin sample of MCP handshake/keepalive
      // (`ping`, healthcheck `initialize`). Volume/health still counts 100% via
      // metrics; errors are separate events and are never dropped here.
      const sampleValue = traceSampleValue(event) ?? Math.random();
      if (transactionDropReason(event, sampleValue)) return null;
      return event;
    },
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

const MAX_INSPECTED_MCP_BODY_BYTES = 64 * 1024;

/**
 * Read a clone of a small JSON-RPC request so the HTTP root can carry the same
 * bounded method classification as its separately-exported MCP child transaction.
 * Never retain request ids, params, tool arguments, or unknown method names.
 */
async function inspectMcpRequest(
  request: Request,
): Promise<McpRequestTelemetry | null> {
  if (request.method !== "POST") return null;
  if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    return null;
  }

  const contentLength = Number(request.headers.get("Content-Length"));
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength <= 0 ||
    contentLength > MAX_INSPECTED_MCP_BODY_BYTES
  ) {
    return null;
  }

  try {
    return classifyMcpRequest(await request.clone().json());
  } catch {
    return null;
  }
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
 * Access-protected MCP endpoint (`/internal`) for managed connectors (e.g. Cowork).
 *
 * Cloudflare Access sits in front of this endpoint with Managed OAuth enabled: it runs
 * the OAuth 2.1 handshake with the client, then forwards each request to this origin
 * carrying a `Cf-Access-Jwt-Assertion` header. We verify that header (JWKS + RS256 +
 * aud/iss/exp + email-domain gate), then serve MCP against the shared server-side
 * Plausible API key. The Worker itself runs no OAuth server.
 */
async function handleInternalMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
    return jsonError("Server misconfigured: missing Cloudflare Access verification config.", 500);
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    // No assertion means the request didn't come through Access — fail closed.
    return jsonError("Forbidden: missing Cloudflare Access assertion.", 403);
  }

  const allowedEmailDomains = parseAllowedEmailDomains(env.ALLOWED_EMAIL_DOMAIN);
  const identity = await verifyCloudflareAccessJwt(token, {
    teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
    aud: env.CF_ACCESS_AUD,
    allowedEmailDomains,
  });
  if (!identity) {
    return jsonError(
      `Forbidden: a valid identity in an allowed domain (${allowedEmailDomains.join(", ")}) is required.`,
      403,
    );
  }

  Sentry.setUser({ email: identity.email });

  if (!env.PLAUSIBLE_API_KEY) {
    return jsonError("Server misconfigured: missing shared Plausible API key.", 500);
  }

  const server = createServer({
    apiKey: env.PLAUSIBLE_API_KEY,
    baseUrl: env.PLAUSIBLE_BASE_URL,
    defaultSiteId: env.PLAUSIBLE_DEFAULT_SITE_ID,
    // Record tool inputs/outputs into Sentry spans on /internal, attributed to the
    // authenticated user via Sentry.setUser({ email }) above. This endpoint is
    // SSO-gated and uses a shared server-side key, so per-user I/O gives us
    // attribution/abuse-tracing on the shared quota. Recorded data is analytics query
    // params (site ids, date ranges) and aggregate traffic numbers — not personal PII
    // — and Authorization/Cookie/JWT headers are still stripped by beforeSendSpan.
    // BYOK (/mcp) deliberately leaves this off: that traffic is a third party's own data.
    recordToolIO: true,
  });

  return createMcpHandler(server, { route: "/internal" })(request, env, ctx);
}

/**
 * Bring-your-own-key MCP endpoint (`/mcp`) for header-capable clients (Claude Code,
 * Cursor, MCP Inspector). Each caller passes their own Plausible API key as a Bearer
 * token. Unchanged from the original public contract — not Access-protected.
 */
async function handleDirectMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Require a well-formed `Bearer <key>` header — a bare token with no scheme is
  // rejected rather than silently accepted, so an accidentally-pasted value fails loudly.
  const authHeader = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  const apiKey = match?.[1]?.trim();

  if (!apiKey) {
    return jsonError(
      "Missing or malformed Authorization header. Pass your Plausible API key as `Bearer <key>`.",
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
 * Emit the `app.server.response` counter for tracked endpoints. Low-cardinality
 * attributes only (normalized route, status class, bucketed client family) so it's
 * safe to group by. This is the volume/health signal that replaces counting off raw
 * spans; untracked scanner routes are skipped so their noise never enters dashboards.
 */
function recordResponseMetric(
  request: Request,
  response: Response,
  tracked: TrackedRoute | null,
  clientFamily: string,
  mcpRequest: McpRequestTelemetry | null,
): void {
  if (!tracked) return;
  Sentry.metrics.count("app.server.response", 1, {
    attributes: {
      "http.request.method": request.method,
      "http.route": tracked.route,
      "app.route.group": tracked.group,
      "http.response.status_code": response.status,
      "app.response.status_class": statusClass(response.status),
      "app.client.family": clientFamily,
      "mcp.method.name": mcpRequest?.method ?? "unknown",
      "app.mcp.request.kind": mcpRequest?.kind ?? "unknown",
    },
  });
}

const handler = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const { pathname } = new URL(request.url);
    const tracked = classifyRoute(pathname);
    const clientFamily = resolveClientFamily(request.headers.get("User-Agent"));

    // Stamp the root request span with a bounded client family + route group so real
    // tool-call traces are groupable without the initialize-only, caller-controlled
    // mcp.client.name. Only for tracked routes — scanner-route transactions are
    // dropped in beforeSendTransaction regardless.
    if (tracked) {
      const span = Sentry.getActiveSpan();
      if (span) {
        span.setAttribute("http.route", tracked.route);
        span.setAttribute("app.route.group", tracked.group);
        span.setAttribute("app.client.family", clientFamily);
      }
    }

    const limited = await rateLimited(request, env);
    const mcpRequest = limited || !tracked
      ? null
      : await inspectMcpRequest(request);

    if (mcpRequest) {
      const span = Sentry.getActiveSpan();
      if (span) {
        span.setAttribute("mcp.method.name", mcpRequest.method);
        span.setAttribute("app.mcp.request.kind", mcpRequest.kind);
      }
    }

    let response: Response;
    if (limited) {
      response = limited;
    } else if (pathname === "/internal" || pathname.startsWith("/internal/")) {
      response = await handleInternalMcp(request, env, ctx);
    } else if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
      response = await handleDirectMcp(request, env, ctx);
    } else {
      response = jsonError("Not found.", 404);
    }

    recordResponseMetric(request, response, tracked, clientFamily, mcpRequest);

    return corsResponse(response);
  },
} satisfies ExportedHandler<Env>;

export default Sentry.withSentry(sentryConfig, handler);
