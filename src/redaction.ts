/**
 * Sentry privacy guardrail shared by the Worker's `beforeSend` and
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
 * name and version identify software, not a person — but pass through
 * `sanitizeClientAttribute` first, because nothing stops a caller putting a person in them.
 */

import type { CloudflareOptions, User } from "@sentry/cloudflare";
import { z } from "zod";

/** A span as the Sentry SDK hands it to `beforeSendSpan`. */
export type SentryStreamedSpan = Parameters<NonNullable<CloudflareOptions["beforeSendSpan"]>>[0];
/** The attribute map of a streamed span, also used for event trace and span data. */
export type SentryAttributes = SentryStreamedSpan["attributes"];

/** The parts of a Sentry event this module redacts. Sentry's `Event` has all of them. */
export interface RedactableEvent {
  user?: User | null;
  contexts?: { trace?: { data?: SentryAttributes } };
  spans?: Array<{ data?: SentryAttributes }>;
  request?: {
    data?: unknown;
    headers?: { [header: string]: string };
    url?: string;
  } | null;
}

const HEADER_ATTRIBUTE_PREFIXES = ["http.request.header.", "http.response.header."];

const CLIENT_ATTRIBUTES = ["mcp.client.name", "mcp.client.version"];
const CLIENT_ATTRIBUTE_MAX_LENGTH = 64;

/**
 * Shapes that identify a person, a machine, or a session rather than a piece of software.
 *
 * The trailing-hostname rule is anchored to the end of a whitespace token on purpose: a
 * hostname ends with its TLD (`laptop.internal`), while a reverse-DNS identifier starts with
 * one (`io.modelcontextprotocol.inspector`). Matching a bare dot anywhere would redact every
 * reverse-DNS name and every `name@version` string.
 *
 * The path rule keys on a slash that no word character precedes, so `@scope/pkg` and
 * `org/client` survive while `/Users/ada/...` and `0.0.0-dev+/Users/ada/...` do not. The
 * opaque-id rule requires a digit in the run, so a long all-letter name is truncated rather
 * than mistaken for a hex session id.
 */
const IDENTITY_PATTERNS = [
  /[^\s@]+@[^\s@]+\.[a-z]{2,}/i,
  /[a-z][a-z0-9+.-]*:\/\//i,
  /(^|[^\w])~?\/[^\s/]/,
  /(^|[^\w])[a-z]:\\/i,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i,
  /\b(?![a-f]+\b)[0-9a-f]{16,}\b/i,
  /\.(com|net|org|io|dev|ai|co|app|local|internal)(\s|$)/i,
];

/**
 * Bound a caller-supplied client identifier before it is stored.
 *
 * `mcp.client.name` and `mcp.client.version` stay because a client library name and version
 * identify software, not a person — but nothing stops a caller putting an operator's email,
 * a workstation hostname, a home directory, or a session id in either field, and the Sentry
 * SDK stores both verbatim (its own `dataCollection` gating covers neither). This is a
 * failsafe against the shapes that leak by accident, not a guarantee: a caller who writes a
 * person's name in prose still gets it through, which only an allow-list would stop.
 *
 * A matching value is replaced wholesale rather than partially masked — a partial mask leaks
 * the surrounding context and turns one bad value into many distinct ones.
 */
export function sanitizeClientAttribute(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (IDENTITY_PATTERNS.some((pattern) => pattern.test(trimmed))) return "[redacted]";
  if (trimmed.length <= CLIENT_ATTRIBUTE_MAX_LENGTH) return trimmed;
  // The cut can end on a shape the whole value did not have, such as a hex run that ran into
  // letters, so the truncated value is checked again.
  return sanitizeClientAttribute(trimmed.slice(0, CLIENT_ATTRIBUTE_MAX_LENGTH));
}

const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const EMAIL_ADDRESS = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;

/**
 * Remove secrets and contact details from free text an agent writes as feedback. The agent
 * holds the caller's Plausible key, so that exact string is the most likely leak; bearer
 * tokens and email addresses catch pasted request headers and site data.
 */
export function scrubFeedbackText(text: string, apiKey: string): string {
  const withoutKey = apiKey ? text.replaceAll(apiKey, "[REDACTED_API_KEY]") : text;
  return withoutKey
    .replace(BEARER_TOKEN, "Bearer [REDACTED]")
    .replace(EMAIL_ADDRESS, "[REDACTED_EMAIL]");
}

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
 * itself — so suppressing it at our own call site is not enough. The surviving
 * `mcp.client.name`/`version` reach this function by that same SDK path, so they are
 * sanitized here rather than only where `recordMcpClientInfo` writes them.
 */
export function stripRequestAttributes(data: SentryAttributes): void {
  for (const key of Object.keys(data)) {
    const lower = key.toLowerCase();
    if (HEADER_ATTRIBUTE_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      delete data[key];
    }
  }
  delete data["mcp.client.title"];
  delete data["url.query"];
  delete data["user_agent.original"];
  const url = text.safeParse(data["url.full"]);
  if (url.success) data["url.full"] = stripUrlQuery(url.data);
  for (const key of CLIENT_ATTRIBUTES) {
    const value = text.safeParse(data[key]);
    if (!value.success) continue;
    const sanitized = sanitizeClientAttribute(value.data);
    if (sanitized === undefined) delete data[key];
    else data[key] = sanitized;
  }
}

/**
 * Always redact authentication headers and header span attributes, on both authenticated and
 * anonymous events. If an event has no authenticated identity — an email for humans, a
 * username for Access service tokens (their client ID, set on /internal) — also treat it as
 * BYOK/anonymous, remove its request body, and replace its `user` with an explicitly IP-less
 * object. Setting `ip_address: null` tells Sentry not to infer one at ingest. Mutates in
 * place; callers return the same event.
 */
export function anonymizeEventWithoutEmail(event: RedactableEvent): void {
  filterCredentialHeaders(event.request?.headers);
  stripEventAttributes(event);
  if (event.request?.url !== undefined) event.request.url = stripUrlQuery(event.request.url);

  if (!isIdentifiedUser(event.user)) {
    event.user = { ip_address: null };
    if (event.request) delete event.request.data;
  }
}

function stripEventAttributes(event: RedactableEvent): void {
  for (const data of [
    event.contexts?.trace?.data,
    ...(event.spans ?? []).map((span) => span.data),
  ]) {
    if (data) stripRequestAttributes(data);
  }
}

const CREDENTIAL_HEADER_PARTS = ["authorization", "cookie", "jwt-assertion", "cf-access"];

function filterCredentialHeaders(headers: { [header: string]: string } | undefined): void {
  for (const key of Object.keys(headers ?? {})) {
    const lower = key.toLowerCase();
    if (headers && CREDENTIAL_HEADER_PARTS.some((part) => lower.includes(part))) {
      headers[key] = "[Filtered]";
    }
  }
}

const text = z.string();
const identifier = z.string().min(1);

/**
 * `/internal` identifies a caller by email for a person and by username (the service
 * token's client id) for a machine; either one counts. Everything else, including the
 * IP the SDK infers, is anonymous.
 */
const identifiedUser = z.union([
  z.object({ email: identifier }),
  z.object({ username: identifier }),
]);
const identifiedSpanUser = z.union([
  z.object({ "user.email": identifier }),
  z.object({ "user.username": identifier }),
]);

export function isIdentifiedUser(user: User | null | undefined): boolean {
  return identifiedUser.safeParse(user).success;
}

export interface RedactableSpan {
  is_segment?: boolean;
  attributes: SentryAttributes;
}

/**
 * Streamed-span twin of `anonymizeEventWithoutEmail`. The SDK derives `user.*` attributes
 * on segment spans (root and MCP child) itself, so an anonymous `/mcp` segment would carry
 * an inferred identity unless it is removed here. Mutates in place.
 */
export function anonymizeSpanWithoutIdentity(span: RedactableSpan): void {
  stripRequestAttributes(span.attributes);
  if (!span.is_segment) return;
  const { attributes } = span;
  if (identifiedSpanUser.safeParse(attributes).success) return;
  for (const key of Object.keys(attributes)) {
    if (key.startsWith("user.")) delete attributes[key];
  }
}
