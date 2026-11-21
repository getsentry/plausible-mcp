import * as Sentry from "@sentry/cloudflare";
import { z } from "zod";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  isJsonContentType,
  originValidationResponse,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { createServer } from "./server.js";
import {
  parseAllowedEmailDomains,
  parseAllowedServiceTokenIds,
  verifyCloudflareAccessJwt,
} from "./cf-access.js";
import { anonymizeEventWithoutEmail, anonymizeSpanWithoutIdentity } from "./redaction.js";
import {
  classifyMcpMethod,
  classifyMcpRequest,
  classifyRoute,
  errorDropReason,
  isKnownMcpMethod,
  isMcpClientRejection,
  resolveClientFamily,
  rootSampleRate,
  statusClass,
  type McpRequestTelemetry,
  type TrackedRoute,
} from "./telemetry.js";
import { landingHtml, landingSecurityPolicy } from "./landing.js";
import type { Env } from "./env.js";

const SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Cache-Control": "no-store",
} as const;

const CORS_HEADERS = {
  ...SECURITY_HEADERS,
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Accept, Mcp-Method, Mcp-Name, MCP-Protocol-Version",
  "Access-Control-Expose-Headers": "WWW-Authenticate",
} as const;

function corsResponse(response: Response): Response {
  const patched = new Response(response.body, response);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    patched.headers.set(key, value);
  }
  return patched;
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function bearerAuthError(message: string, error: "invalid_request" | "invalid_token"): Response {
  const response = jsonError(message, 401);
  response.headers.set("WWW-Authenticate", `Bearer realm="plausible-mcp", error="${error}"`);
  return response;
}

function parseHostnameList(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((hostname) => hostname.trim())
      .filter(Boolean) ?? []
  );
}

function mcpRequestValidationResponse(
  request: Request,
  env: Env,
  route: TrackedRoute,
): Response | undefined {
  const allowedHostnames = parseHostnameList(env.MCP_ALLOWED_HOSTNAMES);
  if (allowedHostnames.length === 0) {
    return jsonError("Server misconfigured: missing MCP hostname allowlist.", 500);
  }

  const hostRejection = hostHeaderValidationResponse(request, allowedHostnames);
  if (hostRejection) return hostRejection;

  const origin = request.headers.get("Origin");
  if (!origin) return undefined;

  if (route.group === "internal") {
    return originValidationResponse(request, parseHostnameList(env.MCP_ALLOWED_ORIGIN_HOSTNAMES));
  }

  // BYOK has no ambient credentials: callers must explicitly supply their Plausible key,
  // so valid browser origins remain intentionally open. The helper still rejects opaque
  // and malformed Origin values.
  let originHostname = "";
  try {
    originHostname = new URL(origin).hostname;
  } catch {
    return originValidationResponse(request, []);
  }
  return originValidationResponse(request, originHostname ? [originHostname] : []);
}

/** The server settings an endpoint hands the MCP handler in its AuthInfo. */
const requestServerConfigSchema = z.object({
  apiKey: z.string(),
  baseUrl: z.string().optional(),
  defaultSiteId: z.string().optional(),
  recordToolIO: z.boolean(),
});
type RequestServerConfig = z.infer<typeof requestServerConfigSchema>;

function buildAuthInfo(
  token: string,
  clientId: string,
  serverConfig: RequestServerConfig,
): AuthInfo {
  return {
    token,
    clientId,
    scopes: ["plausible:read"],
    extra: {
      recordMcpClientInfo: true,
      serverConfig,
    },
  };
}

// One handler owns the subscription bus; its factory still creates an isolated server per request.
const workerMcpHandler = createMcpHandler(
  ({ authInfo }) => {
    const serverConfig = requestServerConfigSchema.safeParse(authInfo?.extra?.serverConfig);
    if (!serverConfig.success) {
      throw new Error("Missing authenticated MCP server configuration.");
    }

    return createServer({
      ...serverConfig.data,
      enableFeedbackTool: true,
    });
  },
  {
    legacy: "stateless",
    onerror: (error) => {
      if (!isMcpClientRejection(error)) Sentry.captureException(error);
    },
  },
);

/** Best-effort pathname for a request URL, or null if it doesn't parse. */
function pathnameOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function sentryConfig(env: Env): Sentry.CloudflareOptions {
  return {
    // Set out-of-band (`wrangler secret put SENTRY_DSN`), never hardcoded: this repo is
    // public and forks deploy it as-is, so a baked-in DSN makes every third-party
    // deployment report into the DSN owner's Sentry project. Unset disables the SDK.
    dsn: env.SENTRY_DSN,
    release: env.SENTRY_RELEASE,
    // Streamed spans cannot be dropped after they start, so every noise rule is a
    // sampling decision made from the request line and headers (see rootSampleRate).
    tracesSampler: ({ parentSampled, normalizedRequest }) =>
      rootSampleRate({
        pathname: pathnameOf(normalizedRequest?.url),
        mcpMethod: normalizedRequest?.headers?.["mcp-method"] ?? null,
        requestMethod: normalizedRequest?.method,
        parentSampled,
      }),
    // v11 collects every category by default. Nothing here is needed for debugging: the
    // route, method, and status carry the signal, and /mcp callers are anonymous by design.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    // Drop the auto-instrumented rate limiter span. @sentry/cloudflare wraps any binding
    // exposing `limit()` and times the call, but records no outcome — the span for an
    // allowed request is identical to one that was throttled, so it carries no signal
    // while running on every request. Matched on the origin attribute rather than the
    // span name, which embeds the binding name. 429s stay visible via the
    // app.server.response metric. beforeSendSpan cannot do this: returning null there
    // only logs a warning and keeps the span.
    ignoreSpans: [{ attributes: { "sentry.origin": "auto.faas.cloudflare.rate_limit" } }],
    // The Cloudflare SDK captures the incoming request body and headers onto the isolation
    // scope before any beforeSend* hook runs; dataCollection alone is not trusted to gate
    // either, so the integrations are overridden explicitly as well. On /mcp
    // that body is the caller's JSON-RPC envelope, whose params._meta carries whatever their
    // client volunteers. Method, URL and status carry the debugging signal we actually use.
    integrations: [
      Sentry.httpServerIntegration({ maxRequestBodySize: "none" }),
      Sentry.requestDataIntegration({
        include: {
          headers: false,
          data: false,
          cookies: false,
          ip: false,
          query_string: false,
        },
      }),
    ],
    // BYOK (`/mcp`) privacy guardrail: only `/internal` sets an identity via Sentry.setUser.
    // Strip the ingest-inferred client IP from every other (anonymous) event so BYOK traffic
    // carries tool names and failures, never who made them. See ./redaction.ts.
    beforeSend(event) {
      anonymizeEventWithoutEmail(event);
      if (errorDropReason(event)) return null;
      return event;
    },
    beforeSendSpan(span) {
      anonymizeSpanWithoutIdentity(span);
      return span;
    },
  };
}

const MAX_INSPECTED_MCP_BODY_BYTES = 64 * 1024;

/** True when Content-Length declares a body small enough to safely clone and parse. */
function hasInspectableContentLength(request: Request): boolean {
  const contentLength = Number(request.headers.get("Content-Length"));
  return (
    Number.isSafeInteger(contentLength) &&
    contentLength > 0 &&
    contentLength <= MAX_INSPECTED_MCP_BODY_BYTES
  );
}

/**
 * Read a clone of a small JSON-RPC request so the HTTP root can carry the same
 * bounded method classification as its MCP child segment.
 * Never retain request ids, params, tool arguments, or unknown method names.
 */
async function inspectMcpRequest(request: Request): Promise<McpRequestTelemetry | null> {
  if (request.method !== "POST") return null;
  if (!isJsonContentType(request.headers.get("Content-Type"))) {
    return null;
  }

  const headerMethod = request.headers.get("Mcp-Method");
  if (headerMethod) return classifyMcpMethod(headerMethod);

  if (!hasInspectableContentLength(request)) return null;

  try {
    return classifyMcpRequest(await request.clone().json());
  } catch {
    return null;
  }
}

/**
 * Give a legacy JSON-RPC POST the `Mcp-Method` header modern clients send, read from a
 * bounded clone of the body, so the sampler and every downstream classifier see one
 * shape. Only known method names are copied; the header is never set from unknown input.
 */
async function withMcpMethodHeader(request: Request): Promise<Request> {
  if (!isInspectableLegacyPost(request)) return request;
  try {
    const body = jsonRpcMethod.safeParse(await request.clone().json());
    if (body.success && isKnownMcpMethod(body.data.method)) {
      const headers = new Headers(request.headers);
      headers.set("Mcp-Method", body.data.method);
      return new Request(request, { headers });
    }
  } catch {
    // fall through to the unmodified request
  }
  return request;
}

const jsonRpcMethod = z.object({ method: z.string() });

/** A small JSON POST to a tracked endpoint that does not name its MCP method in a header. */
function isInspectableLegacyPost(request: Request): boolean {
  return (
    request.method === "POST" &&
    classifyRoute(new URL(request.url).pathname) !== null &&
    isJsonContentType(request.headers.get("Content-Type")) &&
    !request.headers.get("Mcp-Method") &&
    hasInspectableContentLength(request)
  );
}

async function rateLimited(request: Request, env: Env): Promise<Response | null> {
  if (!env.RATE_LIMITER) return null;
  const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.RATE_LIMITER.limit({ key: clientIp });
  if (success) return null;
  return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again later." }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": "60" },
  });
}

/**
 * Access-protected MCP endpoint (`/internal`) for managed connectors (e.g. Cowork).
 *
 * Cloudflare Access sits in front of this endpoint with Managed OAuth enabled: it runs
 * the OAuth 2.1 handshake with the client, then forwards each request to this origin
 * carrying a `Cf-Access-Jwt-Assertion` header. We verify that header (JWKS + RS256 +
 * aud/iss/exp + email-domain or service-token allowlist gate), then serve MCP against the shared server-side
 * Plausible API key. The Worker itself runs no OAuth server.
 */
async function handleInternalMcp(request: Request, env: Env): Promise<Response> {
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
    allowedServiceTokenIds: parseAllowedServiceTokenIds(env.ALLOWED_SERVICE_TOKEN_IDS),
  });
  if (!identity) {
    return jsonError(
      `Forbidden: a valid identity in an allowed domain (${allowedEmailDomains.join(", ")}) is required.`,
      403,
    );
  }

  const subject = identity.kind === "user" ? identity.email : identity.clientId;
  Sentry.setUser(
    identity.kind === "user" ? { email: identity.email } : { username: identity.clientId },
  );

  if (!env.PLAUSIBLE_API_KEY) {
    return jsonError("Server misconfigured: missing shared Plausible API key.", 500);
  }

  const authInfo = buildAuthInfo(token, subject, {
    apiKey: env.PLAUSIBLE_API_KEY,
    baseUrl: env.PLAUSIBLE_BASE_URL,
    defaultSiteId: env.PLAUSIBLE_DEFAULT_SITE_ID,
    // Record tool inputs/outputs into Sentry spans on /internal, attributed to the
    // authenticated user via Sentry.setUser({ email }) above. This endpoint is
    // SSO-gated and uses a shared server-side key, so per-user I/O gives us
    // attribution/abuse-tracing on the shared quota. Recorded data is analytics query
    // params (site ids, date ranges) and aggregate traffic numbers — not personal PII
    // — and Authorization/Cookie/JWT headers are still stripped by the Sentry hooks.
    // BYOK (/mcp) deliberately leaves this off: that traffic is a third party's own data.
    recordToolIO: true,
  });

  return workerMcpHandler.fetch(request, { authInfo });
}

/**
 * Bring-your-own-key MCP endpoint (`/mcp`) for header-capable clients (Claude Code,
 * Cursor, MCP Inspector). Each caller passes their own Plausible API key as a Bearer
 * token. Unchanged from the original public contract — not Access-protected.
 */
async function handleDirectMcp(request: Request, env: Env): Promise<Response> {
  // Require a well-formed `Bearer <key>` header — a bare token with no scheme is
  // rejected rather than silently accepted, so an accidentally-pasted value fails loudly.
  const authHeader = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  const apiKey = match?.[1]?.trim();

  if (!apiKey) {
    return bearerAuthError(
      "Missing or malformed Authorization header. Pass your Plausible API key as `Bearer <key>`.",
      "invalid_request",
    );
  }

  if (apiKey.length < 8) {
    return bearerAuthError("Invalid API key. Key is too short.", "invalid_token");
  }

  try {
    const authInfo = buildAuthInfo(apiKey, "plausible-api-key", {
      apiKey,
      baseUrl: env.PLAUSIBLE_BASE_URL,
      defaultSiteId: env.PLAUSIBLE_DEFAULT_SITE_ID,
      recordToolIO: false,
    });
    return await workerMcpHandler.fetch(request, { authInfo });
  } catch (error) {
    Sentry.captureException(error);
    return jsonError("MCP request failed.", 500);
  }
}

/** What the Worker learned about a request to a tracked endpoint, for spans and metrics. */
interface TrackedRequest {
  tracked: TrackedRoute;
  clientFamily: string;
  mcpRequest: McpRequestTelemetry | null;
}

/**
 * Emit the `app.server.response` counter for tracked endpoints. Low-cardinality
 * attributes only (normalized route, status class, bucketed client family) so it's
 * safe to group by. This is the volume/health signal that replaces counting off raw
 * spans; untracked scanner routes are skipped so their noise never enters dashboards.
 */
function recordResponseMetric(request: Request, response: Response, info: TrackedRequest): void {
  Sentry.metrics.count("app.server.response", 1, {
    attributes: {
      "http.request.method": request.method,
      "http.route": info.tracked.route,
      "app.route.group": info.tracked.group,
      "http.response.status_code": response.status,
      "app.response.status_class": statusClass(response.status),
      "app.client.family": info.clientFamily,
      "mcp.method.name": info.mcpRequest?.method ?? "unknown",
      "app.mcp.request.kind": info.mcpRequest?.kind ?? "unknown",
    },
  });
}

async function serveLanding(request: Request, env: Env, url: URL): Promise<Response> {
  const limited = await rateLimited(request, env);
  if (limited) return limited;
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  return new Response(request.method === "HEAD" ? null : landingHtml(url.origin + "/mcp"), {
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": landingSecurityPolicy,
    },
  });
}

/**
 * Stamp the root request span with a bounded client family and route group, so real
 * tool-call traces are groupable without relying on caller-controlled mcp.client.name.
 * Scanner-route requests are never sampled (rootSampleRate), so only tracked routes get it.
 */
function stampRootSpan(info: TrackedRequest): void {
  const span = Sentry.getActiveSpan();
  if (!span) return;
  span.setAttribute("http.route", info.tracked.route);
  span.setAttribute("app.route.group", info.tracked.group);
  span.setAttribute("app.client.family", info.clientFamily);
  if (info.mcpRequest) {
    span.setAttribute("mcp.method.name", info.mcpRequest.method);
    span.setAttribute("app.mcp.request.kind", info.mcpRequest.kind);
  }
}

function routeTo(request: Request, env: Env, pathname: string): Promise<Response> | Response {
  if (pathname === "/internal" || pathname.startsWith("/internal/")) {
    return handleInternalMcp(request, env);
  }
  if (pathname === "/mcp" || pathname.startsWith("/mcp/")) return handleDirectMcp(request, env);
  return jsonError("Not found.", 404);
}

/** Validate, rate-limit, classify and serve a request to /mcp or /internal. */
async function serveTracked(request: Request, env: Env, tracked: TrackedRoute): Promise<Response> {
  const clientFamily = resolveClientFamily(request.headers.get("User-Agent"));
  const rejected = mcpRequestValidationResponse(request, env, tracked);
  const earlyResponse = rejected ?? (await rateLimited(request, env));
  const info: TrackedRequest = {
    tracked,
    clientFamily,
    mcpRequest: earlyResponse ? null : await inspectMcpRequest(request),
  };
  stampRootSpan(info);
  const response = earlyResponse ?? (await routeTo(request, env, new URL(request.url).pathname));
  recordResponseMetric(request, response, info);
  return response;
}

const handler = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" && url.hostname === env.LANDING_HOSTNAME) {
      return serveLanding(request, env, url);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const tracked = classifyRoute(url.pathname);
    if (tracked) return corsResponse(await serveTracked(request, env, tracked));
    // Untracked paths share the per-IP rate limit, and get no span attributes or metric.
    const response =
      (await rateLimited(request, env)) ?? (await routeTo(request, env, url.pathname));
    return corsResponse(response);
  },
} satisfies ExportedHandler<Env>;

export const workerHandler = { fetch: handler.fetch };

const sentryHandler = Sentry.withSentry(sentryConfig, handler);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return sentryHandler.fetch(await withMcpMethodHeader(request), env, ctx);
  },
} satisfies ExportedHandler<Env>;
