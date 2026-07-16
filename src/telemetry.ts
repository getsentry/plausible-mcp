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
 * Fraction of MCP handshake/keepalive noise (`ping`, healthcheck `initialize`) to
 * keep as spans. We drop the rest: at 100% they were ~90% of all spans. Keeping a
 * thin sample preserves a heartbeat in Trace Explorer without the flood. Metrics
 * (see recordResponseMetric in worker.ts) still count 100% of these requests, so
 * uptime/volume dashboards are unaffected by this span sampling.
 */
export const HEARTBEAT_SPAN_KEEP_RATE = 0.01;

const KNOWN_MCP_METHODS = new Set([
  "initialize",
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
  "notifications/initialized",
  "notifications/cancelled",
  "notifications/progress",
  "notifications/roots/list_changed",
]);

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
  const method = KNOWN_MCP_METHODS.has(rawMethod) ? rawMethod : "other";

  if (method === "ping") return { method, kind: "heartbeat" };
  if (method === "tools/call") return { method, kind: "tool_call" };

  if (method === "initialize") {
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
      return { method, kind: "heartbeat" };
    }
  }

  return {
    method,
    kind: method === "other" ? "unknown" : "control",
  };
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
      value?: string;
      mechanism?: ErrorMechanismLike;
    }>;
  };
}

/**
 * Drop expected protocol rejections that the MCP SDK reports through its error hook.
 * The HTTP 406 is still returned and counted by `app.server.response`; it is not an
 * application exception that needs an issue in Sentry.
 */
export function errorDropReason(event: ErrorEventLike): string | null {
  for (const exception of event.exception?.values ?? []) {
    if (
      exception.value === "Not Acceptable: Client must accept text/event-stream" &&
      exception.mechanism?.type === "auto.ai.mcp_server" &&
      exception.mechanism.data?.["error_type"] === "transport"
    ) {
      return "mcp-get-without-sse-accept";
    }
  }
  return null;
}

// --- Transaction noise filtering (beforeSendTransaction) ---------------------

interface SpanLike {
  op?: string;
  description?: string;
  data?: Record<string, unknown>;
}

export interface TransactionLike {
  transaction?: string;
  request?: { url?: string };
  contexts?: {
    trace?: {
      op?: string;
      trace_id?: string;
      data?: Record<string, unknown>;
    };
  };
  spans?: SpanLike[];
}

/** Best-effort pathname for a finished transaction, or null if undeterminable. */
function transactionPathname(event: TransactionLike): string | null {
  const url = event.request?.url;
  if (url) {
    try {
      return new URL(url).pathname;
    } catch {
      // fall through to the transaction-name parse
    }
  }
  // Transaction names look like "POST /mcp" or "GET /.env".
  const name = event.transaction;
  if (name) {
    const match = /\s(\/\S*)/.exec(name);
    if (match) return match[1];
  }
  return null;
}

/** The span carrying MCP method metadata (HTTP root, MCP root, or child), if any. */
function mcpSpanData(event: TransactionLike): Record<string, unknown> | null {
  const trace = event.contexts?.trace;
  if (
    trace?.data &&
    (trace.op === "mcp.server" || "mcp.method.name" in trace.data)
  ) {
    return trace.data;
  }
  for (const span of event.spans ?? []) {
    if (span.op === "mcp.server" && span.data) return span.data;
  }
  return null;
}

/**
 * Stable 0..1 sample value shared by every transaction in a trace. Sampling the
 * HTTP root and MCP child independently creates the misleading empty/orphan traces
 * this filter is intended to prevent.
 */
export function traceSampleValue(event: TransactionLike): number | null {
  const traceId = event.contexts?.trace?.trace_id;
  if (!traceId || !/^[0-9a-f]{32}$/i.test(traceId)) return null;
  return Number.parseInt(traceId.slice(0, 8), 16) / 0x1_0000_0000;
}

/**
 * Decide whether a finished transaction is noise we should not send to Sentry.
 * Returns a short reason string to drop it, or null to keep it. `rand` (0..1) is
 * injected so the sampling branches are deterministically testable.
 *
 * Kept: every real tool call, and every error (errors are separate events that
 * never reach beforeSendTransaction). Dropped: untracked scanner routes entirely,
 * and all but HEARTBEAT_SPAN_KEEP_RATE of `ping` / healthcheck-`initialize` noise.
 */
export function transactionDropReason(
  event: TransactionLike,
  rand: number,
): string | null {
  const pathname = transactionPathname(event);
  if (pathname !== null && classifyRoute(pathname) === null) {
    return "untracked-route";
  }

  const data = mcpSpanData(event);
  if (data) {
    const method = data["mcp.method.name"];
    const client = data["mcp.client.name"];
    const requestKind = data["app.mcp.request.kind"];
    if (rand >= HEARTBEAT_SPAN_KEEP_RATE) {
      if (method === "ping") return "ping";
      if (
        method === "initialize" &&
        (client === "healthcheck" || requestKind === "heartbeat")
      ) {
        return "healthcheck-initialize";
      }
    }
  }
  return null;
}
