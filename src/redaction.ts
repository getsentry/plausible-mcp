/**
 * Sentry privacy guardrail shared by the Worker's `beforeSend` / `beforeSendTransaction`.
 *
 * Only the Access-gated `/internal` endpoint attaches an identity (`Sentry.setUser({ email })`)
 * and records tool inputs/outputs. The bring-your-own-key `/mcp` endpoint must stay fully
 * anonymous: the querying user is a third party using their own Plausible key, and their tool
 * inputs/outputs are their own data. We never record I/O there, and this strips the signals
 * that would otherwise slip through on error events: the client IP address Sentry infers at
 * ingest and the JSON-RPC request body captured by HTTP instrumentation.
 */

export interface RedactableUser {
  email?: unknown;
  ip_address?: string | null;
  [key: string]: unknown;
}

export interface RedactableEvent {
  user?: RedactableUser | null;
  request?: { data?: unknown } | null;
}

/**
 * If an event has no authenticated email, treat it as BYOK/anonymous, remove its request body,
 * and replace its `user` with an explicitly IP-less object. Setting `ip_address: null` tells
 * Sentry not to infer one at ingest. Events that carry an email (the `/internal` path) are left
 * untouched. Mutates in place; callers return the same event.
 */
export function anonymizeEventWithoutEmail(event: RedactableEvent): void {
  const email = event.user?.email;
  if (typeof email !== "string" || email.length === 0) {
    event.user = { ip_address: null };
    if (event.request) delete event.request.data;
  }
}
