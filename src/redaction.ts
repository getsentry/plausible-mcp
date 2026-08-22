/**
 * Sentry privacy guardrail shared by the Worker's `beforeSend` / `beforeSendTransaction` and
 * the `send_feedback` tool's scope event processor (feedback events bypass `beforeSend`).
 *
 * Only the Access-gated `/internal` endpoint attaches an identity (`Sentry.setUser({ email })`)
 * and records tool inputs/outputs. The bring-your-own-key `/mcp` endpoint must stay fully
 * anonymous: the querying user is a third party using their own Plausible key, and their tool
 * inputs/outputs are their own data. Request bodies and header span attributes are never
 * captured in the first place (see `sentryConfig()` in `src/worker.ts`); this strips what
 * remains: authentication headers and HTTP header span attributes on both endpoints, plus the
 * client IP address and JSON-RPC request body for anonymous BYOK traffic. `mcp.client.name`
 * and `mcp.client.version` are deliberately retained on both endpoints — a client library
 * name and version identify software, not a person.
 */

export interface RedactableUser {
  email?: unknown;
  ip_address?: string | null;
  [key: string]: unknown;
}

export interface RedactableEvent {
  user?: RedactableUser | null;
  contexts?: { trace?: { data?: Record<string, unknown> } };
  spans?: Array<{ data?: Record<string, unknown> }>;
  request?: {
    data?: unknown;
    headers?: Record<string, string | null | undefined>;
    url?: unknown;
  } | null;
}

const HEADER_ATTRIBUTE_PREFIXES = ["http.request.header.", "http.response.header."];

/**
 * Neither endpoint reads the query string or the fragment, so anything there is caller
 * noise the SDK would otherwise store verbatim in the URL attributes.
 */
export function stripUrlQuery(url: string): string {
  const separator = url.search(/[?#]/);
  return separator === -1 ? url : url.slice(0, separator);
}

/**
 * Remove the caller-controlled span attributes the SDK records for every request.
 *
 * Header attributes are added for all headers and filtered only by substring match against
 * the SDK's own sensitive-key list, which does not cover client-specific identity headers
 * (e.g. `x-openai-subject`). No header carries signal this server uses, so the whole
 * namespace goes. `user_agent.original` is likewise free-form caller text; `mcp.client.name`
 * already identifies the client software. `url.path` survives as the routing signal.
 *
 * `mcp.client.title` is a free-form display string that may name a person or workspace.
 * `recordMcpClientInfo` never sets it, but a legacy client sends `clientInfo` through the
 * `initialize` handshake, which the Sentry SDK stores per transport and writes onto spans
 * itself — so suppressing it at our own call site is not enough.
 */
export function stripRequestAttributes(data: Record<string, unknown>): void {
  for (const key of Object.keys(data)) {
    const lower = key.toLowerCase();
    if (HEADER_ATTRIBUTE_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      delete data[key];
    }
  }
  delete data["mcp.client.title"];
  delete data["url.query"];
  delete data["user_agent.original"];
  if (typeof data["url.full"] === "string") {
    data["url.full"] = stripUrlQuery(data["url.full"]);
  }
}

/**
 * Always redact authentication headers and header span attributes, on both authenticated and
 * anonymous events. If an event has no authenticated email, also treat it as BYOK/anonymous,
 * remove its request body, and replace its `user` with an explicitly IP-less object. Setting
 * `ip_address: null` tells Sentry not to infer one at ingest. Mutates in place; callers return
 * the same event.
 */
export function anonymizeEventWithoutEmail(event: RedactableEvent): void {
  const headers = event.request?.headers;
  if (headers) {
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (
        lower.includes("authorization") ||
        lower.includes("cookie") ||
        lower.includes("jwt-assertion") ||
        lower.includes("cf-access")
      ) {
        headers[key] = "[Filtered]";
      }
    }
  }

  for (const data of [
    event.contexts?.trace?.data,
    ...(event.spans ?? []).map((span) => span.data),
  ]) {
    if (data) stripRequestAttributes(data);
  }

  if (typeof event.request?.url === "string") {
    event.request.url = stripUrlQuery(event.request.url);
  }

  const email = event.user?.email;
  if (typeof email !== "string" || email.length === 0) {
    event.user = { ip_address: null };
    if (event.request) delete event.request.data;
  }
}
