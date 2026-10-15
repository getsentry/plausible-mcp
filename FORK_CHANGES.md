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

## 2026-10-15 — Pagination and completeness for row results

Issue: [onderwijsin/plausible-mcp#4](https://github.com/onderwijsin/plausible-mcp/issues/4).

- Added zero-based offsets to `get_breakdown` and limit/offset controls to
  `get_conversions`, including per-page conversions. Existing default sizes remain
  20 and 10000 respectively; breakdown's existing maximum of 1000 is preserved.
- Both request upstream total-row counts and explicitly order by the first metric
  descending, then every grouping dimension ascending to resolve tied rankings.
  Pagination preserves metrics, filters, dimensions and date scope.
- Added pagination summaries to text and structured outputs: requested limit/offset,
  returned/total rows, has-more, next offset, completeness and warnings. Only a full
  response from offset zero is labelled complete; missing/invalid totals remain
  unknown. Short/inconsistent responses warn about caps or changing data. No hard
  aggregate cap is assumed; offset pagination can continue beyond one page.
- Updated server guidance, README, tool-selection evals, and regression coverage
  for boundary/invalid inputs, empty pages, missing totals, scope preservation,
  ordering and actual request serialization. Existing timeseries/comparison output
  contracts remain unchanged. New behavior uses the shared server for both entries.
- Validation: `pnpm build`, `pnpm typecheck`, `pnpm test`; mocked upstream responses,
  no live deployment or LLM eval run.
