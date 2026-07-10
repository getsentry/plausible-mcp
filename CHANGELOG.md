# Changelog

## 0.3.0

- Add the `/internal` MCP endpoint gated by **Cloudflare Access Managed OAuth**: Access runs the OAuth 2.1 handshake and the Worker verifies the `Cf-Access-Jwt-Assertion` header it injects, then queries a shared server-side Plausible API key. Replaces the earlier self-run OAuth server (no more vendored OAuth provider, `OAUTH_KV`, or cookie secret).
- Harden Access JWT verification: normalize a trailing slash on the team domain, reject tokens on/after `exp`, fail closed on a stale JWKS cache, and return the lowercased email for stable attribution.

## 0.2.0

- Cloudflare Worker deployment with the bring-your-own-key `/mcp` endpoint and Sentry instrumentation. (Pre-changelog; summarized retroactively.)

## 0.1.0

- Initial Plausible MCP server: `get_timeseries`, `get_breakdown`, `get_conversions`, `compare_periods` over the Plausible Stats API v2 (STDIO). (Pre-changelog.)
