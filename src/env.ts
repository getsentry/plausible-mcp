import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Worker environment bindings.
 *
 * The `ACCESS_*` values come from the Cloudflare Access "SaaS / OIDC" application
 * that fronts this MCP server as the upstream identity provider. `CF_ACCESS_TEAM_DOMAIN`
 * is reused to verify the Access id_token signature (its `/cdn-cgi/access/certs` JWKS)
 * and issuer. See README for the dashboard setup and secret mapping.
 */
export interface Env {
  // Plausible
  PLAUSIBLE_BASE_URL?: string;
  PLAUSIBLE_DEFAULT_SITE_ID?: string;
  /** Shared Plausible API key used by the OAuth-protected /mcp endpoint. */
  PLAUSIBLE_API_KEY?: string;

  // Sentry
  SENTRY_RELEASE?: string;

  // Cloudflare bindings
  RATE_LIMITER?: RateLimiter;
  /** KV namespace required by @cloudflare/workers-oauth-provider for tokens/grants/state. */
  OAUTH_KV: KVNamespace;

  // Cloudflare Access (upstream OIDC provider)
  /** e.g. https://<team>.cloudflareaccess.com — used for id_token JWKS + issuer check. */
  CF_ACCESS_TEAM_DOMAIN: string;
  ACCESS_CLIENT_ID: string;
  ACCESS_CLIENT_SECRET: string;
  ACCESS_AUTHORIZATION_URL: string;
  ACCESS_TOKEN_URL: string;
  /** 32-byte hex secret (openssl rand -hex 32) for signing approval/CSRF cookies. */
  COOKIE_ENCRYPTION_KEY: string;

  /** Injected at runtime by OAuthProvider before dispatching to handlers. */
  OAUTH_PROVIDER: OAuthHelpers;
}

/**
 * Authenticated user properties, encrypted into the access token by OAuthProvider
 * and surfaced on `ctx.props` inside the protected MCP handler.
 */
export interface Props {
  email: string;
  [key: string]: unknown;
}
