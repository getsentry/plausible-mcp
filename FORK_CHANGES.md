# Fork changes

## 2026-10-15 — Cloudflare observability and Issues

- Enabled Worker observability and real-time Issues in `wrangler.toml` so deployments
  retain Cloudflare diagnostic logs and surface runtime issues.
- Redacted request query strings from Cloudflare logs and traces to protect caller
  data. Existing Sentry configuration and both entry points remain unchanged.
- Compatible with the installed Wrangler schema; validation: `pnpm build`,
  `pnpm typecheck`, and `pnpm test`. No deployment performed.

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

## 2026-10-15 — Explicit imported historical statistics

Issue: [onderwijsin/plausible-mcp#6](https://github.com/onderwijsin/plausible-mcp/issues/6).

- Added optional boolean `include_imports` to timeseries, breakdowns, conversions
  and comparisons. Forwards explicit true/false to `include.imports`, merging with
  `include.total_rows` for paginated tools. Omission preserves native-only defaults.
- Text and structured responses include import coverage when requested explicitly
  or reported upstream, preserving `imports_included`, `imports_skip_reason`, and
  `imports_warning`. Skipped/unconfirmed imports produce explicit warnings; native
  metrics remain intact and missing imported history is never synthesized as zero.
- Comparisons keep coverage separate for each period; existing aggregate/delta
  calculations remain unchanged. Agent guidance warns to check coverage before
  interpreting deltas. Without a setting or upstream metadata, old output shapes
  remain unchanged. Shared registration covers both STDIO and Worker entry points.
- Added documentation, tool-selection evals, regression tests for every query
  tool, default/false behavior, unsupported combinations, absent metadata and empty
  results, independent comparison coverage and merged request serialization.
- Validation: `pnpm build`, `pnpm typecheck`, `pnpm test` with mocked upstream
  responses. No live API, deployment or LLM eval run.

## 2026-10-15 — Preserve metadata and resolved query scope

Issue: [onderwijsin/plausible-mcp#7](https://github.com/onderwijsin/plausible-mcp/issues/7).

- Added upstream `meta` and `query` to structured timeseries, breakdown and
  conversion outputs. Open record schemas preserve all returned warning/coverage
  fields, resolved scope and future nested metadata without reconstructing values.
- Comparisons retain metadata and resolved queries independently inside each
  period, in both text and structured output. Existing metric values, range labels,
  import summaries and delta calculations remain compatible, including nulls.
- Missing upstream context remains absent, while explicit empty objects remain
  empty. Made response types and import/pagination helpers tolerate absent context.
  No new metadata, resolved dates or coverage claims are manufactured.
- Added regression coverage across all statistics tools for null metrics, import
  and metric warnings, unknown nested metadata, missing fields and differing
  per-period context, plus MCP transport assertions. Shared code covers STDIO and
  Worker registrations; no endpoint or telemetry configuration changes.
- Validation: `pnpm build`, `pnpm typecheck`, `pnpm test` with mocked responses;
  no live API or deployment run.

## 2026-10-15 — Correct trailing page wildcards to literal prefixes

Issue: [onderwijsin/plausible-mcp#10](https://github.com/onderwijsin/plausible-mcp/issues/10).

- Changed the shared page shortcut so a final `*` generates an anchored RE2
  `matches` filter with the preceding text escaped literally. `/traineeship*`
  includes `/traineeship` and `/traineeship/apply`, excluding `/archive/traineeship`.
  Exact inputs retain the existing `is` filter.
- Compatibility decision: correct the documented wildcard contract rather than
  preserve accidental substring broadening. Callers wanting the previous scope
  must explicitly use `property_filters` with `event:page` and `contains`.
- Applied consistently to timeseries, breakdowns, conversions and both comparison
  periods. Deployments without `matches` support return the upstream error with
  no broader fallback. Updated shared parameter descriptions, agent guidance,
  README and tool-selection eval; resolved query filters remain inspectable.
- Regression tests cover the three reported paths, regex metacharacters, Unicode,
  root/empty prefixes, literal internal asterisks, scope across every query tool,
  effective returned filters and honest upstream rejection.
- Validation: `pnpm build`, `pnpm typecheck`, `pnpm test` with mocked API responses.
  No live deployment or LLM eval run.

## 2026-10-15 — Configured goal discovery independent of activity

Issue: [onderwijsin/plausible-mcp#2](https://github.com/onderwijsin/plausible-mcp/issues/2).

- Added read-only `get_goals`, using documented `GET /api/v1/sites/goals` with the
  caller's existing key and configured host. Supports explicit/default sites and
  cursor pagination at a fixed 100 definitions per page, for STDIO and Worker.
- Returns configured display names, event/page definitions, custom properties and
  additional upstream definition fields without depending on observed conversions.
  Agents can select the actual webinar-registration display name for statistics.
- Available empty configuration is distinct from unsupported, denied or unavailable
  discovery. Completeness makes partial inventories explicit; absent/malformed page
  metadata cannot establish missing goals. Errors expose no upstream bodies, goal
  definitions or default site IDs. No broader key, scraping or activity inference.
- Added usage/agent guidance, tool-selection eval and tests for configured goals
  without activity, confirmed empty inventories, paging, default/explicit sites,
  unknown fields, permissions/version failures, malformed/network responses, safe
  failure outputs and MCP transport. Updated tool counts for modern/legacy clients.
- Validation: `pnpm build`, `pnpm typecheck`, `pnpm test` with mocked responses;
  no live API, deployment or LLM eval run.

## 2026-10-15 — Single-period aggregate query

Issue: [onderwijsin/plausible-mcp#3](https://github.com/onderwijsin/plausible-mcp/issues/3).

- Added read-only `get_aggregate` to shared STDIO/Worker registration. One
  dimensionless Stats API v2 query returns interval-wide totals and rates, with
  default visitors, visits, pageviews, bounce_rate and visit_duration metrics.
- Accepts explicit/default sites, date ranges, metric selection and the existing
  page/goal/property filters plus optional imports. Reuses overlap checks, literal
  prefix scope, output schemas, upstream metadata/query preservation, import
  coverage and status-safe error reporting. Added a fixed tool-name error metric
  label without altering telemetry identity or input/output policies.
- Null metrics and empty result sets remain untouched; no time-bucket summation,
  rate averaging, duplicate comparison query, filter removal or silent metric
  substitution. Existing tools retain their contracts.
- Added documentation, agent guidance, tool-selection eval and tests for the
  five-KPI interval, single request serialization, filters, scope, imports,
  metadata, nulls/empty results, input errors and upstream incompatibilities.
  MCP transport and modern/legacy Worker tool discovery include the new tool.
- Validation: `pnpm build`, `pnpm typecheck`, `pnpm test` with mocked API responses;
  no live API, deployment or LLM eval run.

## 2026-10-15 — Deploy Worker on merges to main

- Added `.github/workflows/deploy.yml`, triggered by pushes to `main`, including
  merged pull requests. Uses the existing Node 22/pnpm setup, frozen dependencies,
  build, Worker typecheck and tests before deploying with the installed Wrangler.
- Reads only `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` Actions secrets at
  the deployment step. Serializes deployments and uses read-only GitHub permissions.
  Runtime secrets remain in Cloudflare. Direct Wrangler deployment avoids requiring
  Sentry release credentials or uploading sourcemaps to the upstream project.
- Documented required repository/organization secrets and deployment behavior.
- Validation: workflow YAML parse, `pnpm build`, `pnpm typecheck`, `pnpm test`.
  No live deployment performed.
