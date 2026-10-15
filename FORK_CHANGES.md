# Fork changes

Fork source: [getsentry/plausible-mcp](https://github.com/getsentry/plausible-mcp).
Tracking baseline: `3a68586d8a26ef91028d0039b1f20a425318ecdf`, the fork checkout
before this work. This log records changes from that baseline onward; earlier
history has not been audited for differences from upstream. Keep this file updated
with every fork-specific change. Release versions and `CHANGELOG.md` remain owned
by craft.

## 2026-10-15 — Authorized site discovery and reporting zones

Issue: [onderwijsin/plausible-mcp#1](https://github.com/onderwijsin/plausible-mcp/issues/1).

- Added read-only `get_sites` to the shared MCP server, available over STDIO and
  the Worker. Lists authorized sites with cursor pagination, retrieves one site,
  and verifies the configured default with the caller's key before exposing it.
- Returns reporting time zones and site-local `today` for calendar-date resolution.
  Missing/invalid zones are explicitly unavailable, with no inferred fallback.
  Existing query tools still pass relative ranges to Plausible unchanged.
- Uses only documented read-only Sites API endpoints on the configured host.
  Permission, unsupported endpoint/version and other availability failures are
  explicit; failure responses contain no site IDs or upstream response bodies.
  No separate elevated discovery key, account-wide cache or new configuration.
- Added tool-selection eval, regression tests, usage guidance, and contributor
  instructions to maintain this log. Existing statistics tool contracts unchanged.
- Validation: `pnpm build`, `pnpm typecheck`, `pnpm test` (mocked API; no live
  deployment or account permissions verified). LLM eval requires external credentials
  and was not run.
