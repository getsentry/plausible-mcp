/**
 * Sentry privacy guardrail shared by the Worker's `beforeSend` / `beforeSendTransaction`.
 *
 * Only the Access-gated `/internal` endpoint attaches an identity (`Sentry.setUser({ email })`)
 * and records tool inputs/outputs. The bring-your-own-key `/mcp` endpoint must stay fully
 * anonymous: the querying user is a third party using their own Plausible key, and their tool
 * inputs/outputs are their own data. We never record I/O there, and this strips the only user
 * signal that would otherwise slip through — the client IP address Sentry infers at ingest —
 * so BYOK events carry tool names and failures, never who made them.
 */

export interface RedactableUser {
  email?: unknown;
  ip_address?: string | null;
  [key: string]: unknown;
}

export interface RedactableEvent {
  user?: RedactableUser | null;
}

/**
 * If an event has no authenticated email, treat it as BYOK/anonymous and replace its `user`
 * with an explicitly IP-less object. Setting `ip_address: null` tells Sentry not to infer one
 * at ingest, so no personal data remains. Events that carry an email (the `/internal` path)
 * are left untouched. Mutates in place; callers return the same event.
 */
export function anonymizeEventWithoutEmail(event: RedactableEvent): void {
  const email = event.user?.email;
  if (typeof email !== "string" || email.length === 0) {
    event.user = { ip_address: null };
  }
}
