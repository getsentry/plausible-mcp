interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Worker environment bindings.
 *
 * `/internal` is fronted by a Cloudflare Access application with Managed OAuth enabled.
 * Access runs the OAuth 2.1 flow with the client and forwards each request to this
 * origin with a `Cf-Access-Jwt-Assertion` header. `CF_ACCESS_TEAM_DOMAIN` verifies the
 * assertion's signature (its `/cdn-cgi/access/certs` JWKS) and issuer; `CF_ACCESS_AUD`
 * is the Access application's Application Audience (AUD) tag, checked against the token's
 * `aud`. See README for the dashboard setup and secret mapping.
 */
export interface Env {
  // Plausible
  PLAUSIBLE_BASE_URL?: string;
  PLAUSIBLE_DEFAULT_SITE_ID?: string;
  /** Shared Plausible API key used by the Access-protected /internal endpoint. */
  PLAUSIBLE_API_KEY?: string;

  // Sentry
  SENTRY_RELEASE?: string;

  /**
   * Optional: comma-separated email domain(s) allowed to sign in to /internal (the "@"
   * is optional, e.g. "acme.com" or "acme.com,contractors.acme.com"). Defaults to
   * "sentry.io". Self-hosters must set this to their own domain(s) — the upstream Access
   * policy alone is not enough, the verified email is also checked here.
   */
  ALLOWED_EMAIL_DOMAIN?: string;

  // Cloudflare bindings
  RATE_LIMITER?: RateLimiter;

  // Cloudflare Access (Managed OAuth fronting /internal)
  /** e.g. https://<team>.cloudflareaccess.com — used for the assertion JWKS + issuer check. */
  CF_ACCESS_TEAM_DOMAIN: string;
  /** The Access application's Application Audience (AUD) tag — checked against the token `aud`. */
  CF_ACCESS_AUD: string;
}
