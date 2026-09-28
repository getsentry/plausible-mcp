/**
 * Telemetry helpers shared by the Worker's Sentry config (src/worker.ts).
 *
 * The bigger picture: this Worker is a public endpoint, so most of what Sentry
 * sees is not our users. Two failure modes dominate production data:
 *
 *  1. Volume/health was being read off 100%-sampled raw spans, so vulnerability
 *     scanners (`/.env`, `/wp-admin`, `/.git/config`) and an uptime monitor doing
 *     ~85k `initialize` calls buried the ~3k real tool calls. Counting belongs in
 *     cheap, bounded *metrics*; spans are for debugging one request.
 *  2. "Traffic by client" was grouped on the MCP `clientInfo.name`, which is both
 *     caller-controlled (a monitor self-reports "healthcheck") and only present on
 *     the `initialize` message — so every follow-up call bucketed as "(no value)".
 *
 * These functions fix both: a bounded client-family derived from the User-Agent
 * (present on every request), a route allow-list so scanner noise is never a
 * tracked signal, and a drop rule for handshake/keepalive noise. They are pure
 * (no Cloudflare/Sentry globals) so they live in the Node tsconfig and are
 * unit-tested like redaction.ts; worker.ts owns the Sentry-specific wiring.
 */

export type RouteGroup = "mcp" | "internal";
export type McpRequestKind = "heartbeat" | "tool_call" | "control" | "unknown";

export interface McpRequestTelemetry {
  /** Protocol method normalized to a fixed allow-list. */
  method: string;
  kind: McpRequestKind;
}

export interface TrackedRoute {
  group: RouteGroup;
  /** Normalized template — safe as a low-cardinality metric/span dimension. */
  route: string;
}

/**
 * Fraction of MCP handshake/keepalive noise (`server/discover`, `ping`, `tools/list`,
 * healthcheck `initialize`) to keep as spans. We drop the rest: at 100% protocol
 * ceremony was ~90% of all spans. Keeping a thin sample preserves a heartbeat in Trace
 * Explorer without the flood. Metrics (see recordResponseMetric in worker.ts) still
 * count 100% of these requests, so uptime/volume dashboards are unaffected.
 */
export const HEARTBEAT_SPAN_KEEP_RATE = 0.01;

const KNOWN_MCP_METHODS = new Set([
  "initialize",
  "server/discover",
  "ping",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "resources/subscribe",
  "resources/unsubscribe",
  "prompts/list",
  "prompts/get",
  "completion/complete",
  "logging/setLevel",
  "roots/list",
  "sampling/createMessage",
  "elicitation/create",
  "subscriptions/listen",
  "notifications/initialized",
  "notifications/cancelled",
  "notifications/progress",
  "notifications/roots/list_changed",
]);

/** Normalize a protocol method from an MCP HTTP header or JSON-RPC request. */
export function classifyMcpMethod(rawMethod: string): McpRequestTelemetry {
  const method = KNOWN_MCP_METHODS.has(rawMethod) ? rawMethod : "other";

  if (method === "ping" || method === "server/discover") {
    return { method, kind: "heartbeat" };
  }
  if (method === "tools/call") return { method, kind: "tool_call" };

  return {
    method,
    kind: method === "other" ? "unknown" : "control",
  };
}

/**
 * Extract only bounded protocol metadata from an already-parsed JSON-RPC body.
 * Request ids, params, tool arguments, and caller-defined method names are ignored.
 */
export function classifyMcpRequest(payload: unknown): McpRequestTelemetry {
  if (Array.isArray(payload)) return { method: "batch", kind: "control" };
  if (!payload || typeof payload !== "object") {
    return { method: "unknown", kind: "unknown" };
  }

  const message = payload as Record<string, unknown>;
  const rawMethod = typeof message.method === "string" ? message.method : "";
  if (!rawMethod) return { method: "unknown", kind: "unknown" };
  const classified = classifyMcpMethod(rawMethod);

  if (classified.method === "initialize") {
    const params = message.params;
    const clientInfo =
      params && typeof params === "object"
        ? (params as Record<string, unknown>).clientInfo
        : undefined;
    const clientName =
      clientInfo && typeof clientInfo === "object"
        ? (clientInfo as Record<string, unknown>).name
        : undefined;
    if (clientName === "healthcheck") {
      return { method: classified.method, kind: "heartbeat" };
    }
  }

  return classified;
}

/**
 * Map a request path to one of our two real endpoints, or null for anything else.
 * Everything else the public hostname receives is internet background radiation —
 * scanners probing `/.env`, `/wp-admin`, `/.git/config`, `favicon.ico`, `/`, etc.
 * Returning null lets callers skip metrics and drop the transaction, so that noise
 * never becomes a tracked signal.
 */
export function classifyRoute(pathname: string): TrackedRoute | null {
  if (pathname === "/internal" || pathname.startsWith("/internal/")) {
    return { group: "internal", route: "/internal" };
  }
  if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
    return { group: "mcp", route: "/mcp" };
  }
  return null;
}

/** True for `/mcp/<more>` and `/internal/<more>`; false for the endpoints themselves. */
export function isTrackedSubpath(pathname: string): boolean {
  return /^\/(?:mcp|internal)\/.+/.test(pathname);
}

/** `200` -> `"2xx"`. Low-cardinality status bucket for metrics. */
export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

/**
 * Bucket the User-Agent into a fixed, low-cardinality set of client families.
 *
 * Deliberately NOT the MCP `clientInfo.name` the SDK records on `mcp.client.name`:
 * that only rides the `initialize` message (so it's null on every ping/tool call
 * against this stateless per-request server) and is a free-form, caller-controlled
 * string (monitors send "healthcheck", scanners send anything) — unbounded
 * cardinality a dashboard dimension must not trust. The User-Agent is on every
 * request; bucketed here it is bounded and safe to group by. The raw
 * `mcp.client.name` still rides `initialize` spans for per-trace deep dives.
 *
 * Tradeoff: SDK/proxy-based clients (mcp-remote, bare fetch) expose a generic UA
 * and collapse into `mcp-remote`/`node`/`python`/`other` rather than a product
 * name. That's the intended cost of a bounded dimension.
 */
export function resolveClientFamily(userAgent: string | null | undefined): string {
  if (!userAgent) return "unknown";
  const ua = userAgent.toLowerCase();

  if (ua.startsWith("claude-code/")) return "claude-code";
  if (ua.startsWith("cursor/")) return "cursor";
  if (ua.includes("codex")) return "codex";
  if (ua.includes("mcp-remote")) return "mcp-remote";
  if (
    ua.startsWith("claude-user") ||
    ua.includes("claude-ai") ||
    ua.includes("anthropic")
  ) {
    return "claude";
  }
  if (ua.includes("openai")) return "openai";
  if (ua.startsWith("go-http-client/")) return "go";
  if (ua.startsWith("java") || ua.startsWith("reactornetty/")) return "java";
  if (
    ua.startsWith("python") ||
    ua.startsWith("aiohttp/") ||
    ua.includes("httpx")
  ) {
    return "python";
  }
  if (
    ua === "node" ||
    ua.startsWith("node-fetch/") ||
    ua.startsWith("undici") ||
    ua.startsWith("bun/")
  ) {
    return "node";
  }

  return "other";
}

// --- Expected error filtering (beforeSend) -----------------------------------

interface ErrorMechanismLike {
  type?: string;
  data?: Record<string, unknown>;
}

export interface ErrorEventLike {
  exception?: {
    values?: Array<{
      type?: string;
      value?: string;
      mechanism?: ErrorMechanismLike;
    }>;
  };
}

/**
 * Drop expected protocol rejections that the MCP SDK reports through its error hook.
 * The transport already answers these itself (406 for GET without SSE support, 400
 * with a JSON-RPC -32700 for an unparseable POST body — scanners and curl probes),
 * and both responses are still counted by `app.server.response`; neither is an
 * application exception that needs an issue in Sentry.
 *
 * The transport reports the unparseable body two ways: MCP SDK 2.0 wrapped it in a
 * "Parse error" message, while 2.1 hands the hook the raw `SyntaxError` from
 * `JSON.parse`, whose text varies with the input, before answering the same 400.
 */
export function errorDropReason(event: ErrorEventLike): string | null {
  for (const exception of event.exception?.values ?? []) {
    if (exception.mechanism?.type !== "auto.ai.mcp_server") continue;
    const fromTransport = exception.mechanism.data?.["error_type"] === "transport";
    if (
      exception.value === "Not Acceptable: Client must accept text/event-stream" &&
      fromTransport
    ) {
      return "mcp-get-without-sse-accept";
    }
    if (
      exception.value === "Parse error: Invalid JSON" ||
      exception.value === "Parse error: Invalid JSON-RPC message" ||
      (exception.type === "SyntaxError" && fromTransport)
    ) {
      return "mcp-body-parse-error";
    }
  }
  return null;
}

// --- Root span sampling (tracesSampler) ---------------------------------------

export interface RootSpanSampleInput {
  /** Request pathname, or null when the URL could not be parsed. */
  pathname: string | null;
  /** Raw `Mcp-Method` request header, or null when absent. */
  mcpMethod: string | null;
  /** Sampling decision of the enclosing root span, when this span has one. */
  parentSampled?: boolean;
}

/**
 * Sample rate for a root span, decided when it starts. Streamed spans cannot be
 * dropped once started, so every noise rule is a rate here: 0 for scanner routes,
 * sub-paths with no MCP method (`/mcp/actuator/heapdump`), and the two handshake
 * notifications; HEARTBEAT_SPAN_KEEP_RATE for `ping`, `server/discover`,
 * `tools/list`, and `initialize`; 1 for everything else. An MCP child segment
 * passes its parent's decision through so root and child are kept or dropped together.
 * `app.server.response` still counts 100% of requests.
 */
export function rootSampleRate(input: RootSpanSampleInput): number {
  if (typeof input.parentSampled === "boolean") return Number(input.parentSampled);
  if (input.pathname === null) return 1;
  if (classifyRoute(input.pathname) === null) return 0;
  if (isTrackedSubpath(input.pathname) && input.mcpMethod === null) return 0;
  if (input.mcpMethod === null) return 1;

  const classified = classifyMcpMethod(input.mcpMethod);
  if (
    classified.method === "notifications/initialized" ||
    classified.method === "notifications/roots/list_changed"
  ) {
    return 0;
  }
  if (
    classified.kind === "heartbeat" ||
    classified.method === "tools/list" ||
    classified.method === "initialize"
  ) {
    return HEARTBEAT_SPAN_KEEP_RATE;
  }
  return 1;
}

/** True for every method name `classifyMcpMethod` normalizes rather than folding to "other". */
export function isKnownMcpMethod(rawMethod: string): boolean {
  return KNOWN_MCP_METHODS.has(rawMethod);
}
