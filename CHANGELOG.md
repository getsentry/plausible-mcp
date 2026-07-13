# Changelog

## 0.4.0

- Fix stale MCP serverInfo version (0.2.0) and keep it synced on release by @sergical in [#23](https://github.com/getsentry/plausible-mcp/pull/23)
- Add pnpm inspect / inspect:cli for one-command local MCP testing by @sergical in [#22](https://github.com/getsentry/plausible-mcp/pull/22)
- Upgrade to TypeScript 7 and @types/node 26 by @sergical in [#19](https://github.com/getsentry/plausible-mcp/pull/19)
- Upgrade @anthropic-ai/sdk to 0.110 and drop the now-dead form-data override by @sergical in [#18](https://github.com/getsentry/plausible-mcp/pull/18)
- Upgrade dev tooling: vitest 4, @sentry/cli 3, @cloudflare/workers-types 5 by @sergical in [#17](https://github.com/getsentry/plausible-mcp/pull/17)
- Upgrade core runtime: MCP SDK 1.29, zod 4, agents 0.17 by @sergical in [#16](https://github.com/getsentry/plausible-mcp/pull/16)
- Document the two-app Cloudflare Access setup and fix the claude mcp add arg order by @sergical in [#20](https://github.com/getsentry/plausible-mcp/pull/20)
- Bump @sentry/cloudflare to 10.64 and tsx to 4.23 by @sergical in [#15](https://github.com/getsentry/plausible-mcp/pull/15)

## 0.3.1

- Adopt AGENTS.md (CLAUDE.md symlink) and document the craft release process by @sergical in [#14](https://github.com/getsentry/plausible-mcp/pull/14)
- Force form-data >=4.0.6 to fix high-severity CRLF injection (GHSA-hmw2-7cc7-3qxx) by @sergical in [#13](https://github.com/getsentry/plausible-mcp/pull/13)

## 0.3.0

- Add the `/internal` MCP endpoint gated by **Cloudflare Access Managed OAuth**: Access runs the OAuth 2.1 handshake and the Worker verifies the `Cf-Access-Jwt-Assertion` header it injects, then queries a shared server-side Plausible API key. Replaces the earlier self-run OAuth server (no more vendored OAuth provider, `OAUTH_KV`, or cookie secret).
- Harden Access JWT verification: normalize a trailing slash on the team domain, reject tokens on/after `exp`, fail closed on a stale JWKS cache, and return the lowercased email for stable attribution.

## 0.2.0

- Cloudflare Worker deployment with the bring-your-own-key `/mcp` endpoint and Sentry instrumentation. (Pre-changelog; summarized retroactively.)

## 0.1.0

- Initial Plausible MCP server: `get_timeseries`, `get_breakdown`, `get_conversions`, `compare_periods` over the Plausible Stats API v2 (STDIO). (Pre-changelog.)
