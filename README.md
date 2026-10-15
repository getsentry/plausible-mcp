# plausible-mcp

MCP server for [Plausible Analytics](https://plausible.io) — query traffic, conversions, and compare time periods from any AI tool that supports [Model Context Protocol](https://modelcontextprotocol.io).

Built for teams that want to ask questions like:
- "Did our deploy on Tuesday affect traffic to /pricing?"
- "What's the signup conversion rate on /blog this month?"
- "How does this week's bounce rate compare to last week?"

## Tools

| Tool | Description |
|------|-------------|
| `get_timeseries` | Traffic and conversion metrics over time (daily/weekly/monthly) |
| `get_breakdown` | Break down by page, source, country, device, browser, OS, UTM params |
| `get_conversions` | Goal conversion rates, optionally per-page |
| `get_sites` | Discover authorized sites, reporting time zones and site-local today; verify the server default |
| `compare_periods` | Side-by-side comparison of two date ranges with absolute and % deltas |

All query tools are **read-only** and annotated with `readOnlyHint: true`.

Hosted deployments additionally expose `send_feedback`, which files feedback about the server itself (confusing errors, missing capabilities) into the maintainers' Sentry User Feedback inbox. It is only registered when the server runs with Sentry (`enableFeedbackTool`).

## Quick Start

### Remote (Hosted)

A hosted instance is available at **`https://plausible-mcp.sentry.dev`**.

**With your own Plausible API key** (any user):

```bash
claude mcp add --transport http plausible https://plausible-mcp.sentry.dev/mcp --header "Authorization: Bearer YOUR_PLAUSIBLE_API_KEY"
```

> Keep the URL **before** `--header`. `--header` is variadic, so if it comes last it swallows the URL and the CLI fails with `error: missing required argument 'commandOrUrl'`.

Or add manually to your MCP client config (Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "plausible": {
      "url": "https://plausible-mcp.sentry.dev/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_PLAUSIBLE_API_KEY"
      }
    }
  }
}
```

**Sentry employees** (via OAuth 2.1 + Cloudflare Access):

The `/internal` endpoint is an OAuth 2.1 server — no API key needed. Add it as a remote/custom connector in any OAuth-capable MCP client (Cowork, Claude.ai connectors, Claude Desktop):

```
https://plausible-mcp.sentry.dev/internal
```

The client discovers the OAuth endpoints automatically, sends you through Sentry SSO (Cloudflare Access), and only `@sentry.io` identities are granted access. Queries run against a shared, server-side Plausible API key — you never handle a key.

> The **hosted** `/internal` at `plausible-mcp.sentry.dev` is Sentry-only and can't be used outside the org. To run `/internal` for a different organization, [self-host](#self-hosting-cloudflare-workers) and set `ALLOWED_EMAIL_DOMAIN` to your own domain. (The public `/mcp` bring-your-own-key endpoint has no such restriction.)

### Local (STDIO)

If you prefer to run it locally, use Node.js 20 or newer:

```bash
git clone https://github.com/getsentry/plausible-mcp.git
cd plausible-mcp
pnpm install
pnpm build
```

Add to Claude Code:

```bash
claude mcp add plausible -e PLAUSIBLE_API_KEY=your-key -- node /path/to/plausible-mcp/dist/index.js
```

Or Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "plausible": {
      "command": "node",
      "args": ["/path/to/plausible-mcp/dist/index.js"],
      "env": {
        "PLAUSIBLE_API_KEY": "your-key"
      }
    }
  }
}
```

### Self-Hosting (Cloudflare Workers)

Deploy your own instance:

```bash
git clone https://github.com/getsentry/plausible-mcp.git
cd plausible-mcp
pnpm install
npx wrangler deploy
```

The worker exposes two endpoints:

- **`/mcp`** — bring-your-own-key. Each user passes their own Plausible API key via the `Authorization: Bearer` header. No shared secrets needed on the server. Works with any header-capable MCP client (Claude Code, Cursor, MCP Inspector).
- **`/internal`** — Access-protected MCP endpoint for managed connectors (Cowork, Claude.ai). A Cloudflare Access application with **Managed OAuth** fronts the **whole Worker hostname** (see the constraint below): Access runs the OAuth 2.1 handshake with the client and forwards each request to the Worker with a `Cf-Access-Jwt-Assertion` header. The Worker verifies that header and queries a shared, server-side Plausible API key. Access is gated to the email domain(s) in `ALLOWED_EMAIL_DOMAIN` (defaults to `sentry.io`) — **not** tied to Sentry when you self-host; set it to your own domain.

Because the Managed OAuth application must cover the **bare hostname with no path** (Cloudflare rejects a path when OAuth is enabled — `domain can not have a path if oauth is configured`), it also gates `/mcp`. To keep the bring-your-own-key `/mcp` endpoint public you add a **second, more-specific Access application scoped to the `/mcp` path with a `Bypass` policy**. Cloudflare matches the most specific hostname+path first, so `/mcp` requests bypass Access entirely while everything else goes through OAuth. Both apps live on one hostname; no separate subdomain is required.

> **Beta / client requirement.** Cloudflare Access [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/) is in Beta and **requires an MCP client that supports [RFC 8707](https://datatracker.ietf.org/doc/html/rfc8707)** (resource indicators). Confirm your connector supports it before relying on this path.

#### Setting up the `/internal` endpoint (Cloudflare Access Managed OAuth)

The Worker runs **no OAuth server** — Cloudflare Access is the authorization server. There is no `OAUTH_KV`, no cookie key, and no OAuth client id/secret. You create **two** Access applications on the same hostname.

1. **Create the Managed OAuth application over the bare hostname** (Zero Trust → **Access** → Applications): a [self-hosted app](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) or [MCP server application](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/) whose domain is `plausible-mcp.sentry.dev` **with no path**.
   - ⚠️ **Do not scope it to `/internal`.** Once Managed OAuth is enabled, Cloudflare rejects any path with `access.api.error.invalid_request: domain can not have a path if oauth is configured`. The app must be the whole host; the Worker enforces the `/internal` route itself.
   - Add an Access **policy** (Action `Allow`) restricting to your email domain (e.g. `@acme.com`) and identity provider.
   - **Enable Managed OAuth** (Advanced settings → **Managed OAuth**) and set **Allowed redirect URIs** to your connector's actual callback — for Claude/Cowork that is `https://claude.ai/api/mcp/auth_callback`. Public HTTPS callbacks **must** be listed or Dynamic Client Registration fails with `invalid_client_metadata: redirect_uri is not allowed by the account configuration`; loopback (`http://localhost:*`) callbacks are allowed by default.
   - Copy the application's **AUD tag** → this becomes `CF_ACCESS_AUD`.
2. **Carve `/mcp` back out with a second, path-scoped Bypass application.** Because step 1 covers the whole host, `/mcp` (bring-your-own-key) is now gated too. Create another self-hosted app, domain `plausible-mcp.sentry.dev` **path `mcp`**, with **Managed OAuth OFF**, and a policy whose **Action is `Bypass`** with the selector **`Everyone`**.
   - `Bypass` ≠ `Allow`: an `Allow` policy still forces an interactive login (the client gets an HTML `302` to the login page and fails with `Unexpected content type: text/html`). Only `Bypass` lets the request through with no authentication, so the Worker's own Bearer-key check applies.
3. **Set the worker secrets**:
   ```bash
   npx wrangler secret put PLAUSIBLE_API_KEY          # shared key for /internal queries
   npx wrangler secret put SENTRY_DSN                 # optional — the Worker's own telemetry
   ```
   `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are **not** secrets — a public JWKS URL and an application identifier — so they go in `[vars]` in step 4.
4. **Set the `[vars]` in `wrangler.toml`**:
   - `CF_ACCESS_TEAM_DOMAIN` — `https://<team>.cloudflareaccess.com`, no trailing slash. Verifies the `Cf-Access-Jwt-Assertion` JWKS and issuer.
   - `CF_ACCESS_AUD` — the AUD tag you copied in step 1.
   - `ALLOWED_EMAIL_DOMAIN` — the email domain(s) allowed to sign in, comma-separated, `@` optional (default `sentry.io`). Enforced in code **in addition to** the Access policy in step 1, so set it to your own domain — otherwise every login is rejected.
   - `MCP_ALLOWED_HOSTNAMES` — comma-separated hostnames accepted by the MCP endpoints. Replace `plausible-mcp.sentry.dev` with your worker's hostname; keep the localhost entries if you use `wrangler dev`.
   - `MCP_ALLOWED_ORIGIN_HOSTNAMES` — comma-separated browser Origin hostnames allowed to call `/internal`. Non-browser clients do not send an `Origin` header.
5. **Deploy** (`npx wrangler deploy`), then point an RFC 8707-capable MCP client at `https://<your-worker-host>/internal`.

**Troubleshooting.** All of these are Cloudflare Access configuration, not the Worker — a request only reaches the Worker (and its Sentry spans) once Access forwards it:

| Symptom (in the connector) | Cause | Fix |
|---|---|---|
| `Couldn't register … / add an OAuth Client ID` | Connector callback isn't in **Allowed redirect URIs** | Add the exact callback (step 1); read the rejected `redirect_uri` from Zero Trust → Logs → Access |
| `domain can not have a path if oauth is configured` | Managed OAuth app scoped to a path | Rescope app 1 to the bare host (step 1) |
| `/mcp`: `Unexpected content type: text/html` | `/mcp` app policy is `Allow`, not `Bypass` | Set the app-2 policy Action to `Bypass` (step 2) |
| `/mcp`: OAuth `401 invalid_token` | No `/mcp` bypass app; the whole-host OAuth app is gating it | Create app 2 (step 2) |

## Configuration

| Environment Variable | Required | Default | Description |
|---------------------|----------|---------|-------------|
| `PLAUSIBLE_API_KEY` | Yes (STDIO; Worker `/internal`) | — | Your Plausible API key ([get one here](https://plausible.io/docs/stats-api)). On the Worker this is the shared key for `/internal`; `/mcp` takes each user's own key via Bearer. |
| `PLAUSIBLE_BASE_URL` | No | `https://plausible.io` | URL of your Plausible instance (for self-hosted) |
| `PLAUSIBLE_DEFAULT_SITE_ID` | No | — | Default site domain so you don't have to pass `site_id` every call |
| `CF_ACCESS_TEAM_DOMAIN` | Yes (Worker `/internal`) | — | `https://<team>.cloudflareaccess.com` — verifies the `Cf-Access-Jwt-Assertion` JWKS + issuer. No trailing slash. |
| `CF_ACCESS_AUD` | Yes (Worker `/internal`) | — | The Access application's Application Audience (AUD) tag — checked against the assertion's `aud`. |
| `SENTRY_DSN` | No (Worker) | — | Sentry DSN for the Worker's own telemetry (`wrangler secret put SENTRY_DSN`). Unset disables Sentry — use your own DSN if you want telemetry on a self-hosted deployment. |
| `ALLOWED_EMAIL_DOMAIN` | No (Worker `/internal`) | `sentry.io` | Comma-separated email domain(s) allowed to sign in to `/internal`. Set to your own domain when self-hosting. |
| `MCP_ALLOWED_HOSTNAMES` | Yes (Worker) | — | Comma-separated hostname allowlist used to validate MCP `Host` headers. |
| `MCP_ALLOWED_ORIGIN_HOSTNAMES` | No (Worker `/internal`) | — | Comma-separated browser Origin hostnames allowed to call `/internal`. A present Origin is rejected when the list is empty. |

On the Worker, the `/mcp` endpoint needs no server-side key — each user passes their own via `Authorization: Bearer`. The `/internal` endpoint is fronted by Cloudflare Access Managed OAuth and uses a shared server-side `PLAUSIBLE_API_KEY` secret (see [self-hosting](#setting-up-the-internal-endpoint-cloudflare-access-managed-oauth)).

## Plausible API

This server wraps the [Plausible Stats API v2](https://plausible.io/docs/stats-api) (`POST /api/v2/query`). It works with both [Plausible Cloud](https://plausible.io) and [self-hosted](https://plausible.io/docs/self-hosting) instances.

### Supported Metrics

`visitors`, `visits`, `pageviews`, `views_per_visit`, `bounce_rate`, `visit_duration`, `events`, `scroll_depth`, `percentage`, `conversion_rate`, `group_conversion_rate`, `average_revenue`, `total_revenue`, `time_on_page`

### Supported Dimensions

`event:page`, `event:goal`, `event:hostname`, `visit:entry_page`, `visit:exit_page`, `visit:source`, `visit:referrer`, `visit:channel`, `visit:utm_medium`, `visit:utm_source`, `visit:utm_campaign`, `visit:utm_content`, `visit:utm_term`, `visit:device`, `visit:browser`, `visit:browser_version`, `visit:os`, `visit:os_version`, `visit:country`, `visit:region`, `visit:city`, `visit:country_name`, `visit:region_name`, `visit:city_name`

The `*_name` geography dimensions return human-readable names (e.g. "Canada"); the plain `visit:country`/`region`/`city` return ISO/Geoname codes.

### Filtering

Every query tool accepts `property_filters`, which — despite the name — filters by built-in dimensions as well as custom event properties. Each entry is `{ "property", "operator", "values" }`:

- `property` — a built-in dimension (e.g. `visit:channel`, `visit:source`, `event:page`) or a custom property as its bare name (`"plan"` targets `event:props:plan`).
- `operator` — `is`, `is_not`, `contains`, `contains_not` (default `is`). `event:goal` supports only `is` and `contains`.
- Multiple entries combine with AND, as do the `page`/`goal` shortcut parameters. Targeting `event:page`/`event:goal` from both a shortcut and `property_filters` in the same call is rejected — use one or the other.

For example, top pages for organic search traffic: `get_breakdown` with `dimension: "event:page"` and `property_filters: [{ "property": "visit:channel", "values": ["Organic Search"] }]`.

### Custom Properties

Sites send their own [custom event properties](https://plausible.io/docs/custom-props/introduction), addressed as `event:props:<name>`. These are site-specific, so there's no fixed list.

- **Break down by** a custom property: pass `get_breakdown` a `dimension` of `event:props:<name>` (e.g. `event:props:plan`).
- **Filter by** a custom property via `property_filters` with the bare name, e.g. `[{ "property": "plan", "operator": "is", "values": ["pro"] }]`.

## Development

```bash
pnpm install
pnpm build         # TypeScript compilation
pnpm test          # Run unit + integration tests
pnpm test:watch    # Watch mode
```

### Testing with MCP Inspector

```bash
pnpm build
PLAUSIBLE_API_KEY=your-key npx @modelcontextprotocol/inspector node dist/index.js
```

### LLM Evals

Verifies the model picks the right tool for natural language analytics questions. Runs through
OpenRouter, so any tool-calling model works — the default is `anthropic/claude-sonnet-5`:

```bash
OPENROUTER_API_KEY=sk-or-... pnpm eval
OPENROUTER_MODEL=openai/gpt-5 OPENROUTER_API_KEY=sk-or-... pnpm eval  # try another model
```

## Architecture

```
src/
├── index.ts              # STDIO entry point (local use)
├── worker.ts             # Cloudflare Worker entry point (remote)
├── env.ts                # Worker environment bindings
├── cf-access.ts          # Verifies the Cloudflare Access assertion on /internal
├── server.ts             # Creates McpServer, registers all tools
├── plausible.ts          # PlausibleClient — standalone API client
├── schemas.ts            # Shared Zod schemas and filter helpers
├── errors.ts             # UserFacingError and tool-error reporting
├── telemetry.ts          # Pure classifiers — route, MCP request kind, client family
├── mcp-telemetry.ts      # Records MCP client info onto the active span
├── redaction.ts          # Strips PII from Sentry events on the BYOK path
└── tools/
    ├── get-timeseries.ts
    ├── get-breakdown.ts
    ├── get-conversions.ts
    ├── compare-periods.ts
    └── send-feedback.ts
```

`PlausibleClient` has zero MCP dependency and can be used standalone.

### Observability & data collection

The Worker reports to Sentry with an endpoint-dependent privacy posture:

- **`/mcp` (bring-your-own-key)** — fully anonymous. Tool inputs and outputs are **not** recorded (that data belongs to the caller and their own key), no identity is attached, and the ingest-inferred client IP is stripped (`src/redaction.ts`). Only operational telemetry remains: tool names, span timings, and failures.
- **`/internal` (SSO-gated)** — attributed. Requests carry the authenticated `@sentry.io` email (`Sentry.setUser`), and tool inputs/outputs **are** recorded (`recordToolIO`) for attribution and abuse-tracing on the shared server-side key.

`Authorization` / `Cookie` / `Cf-Access-Jwt-Assertion` headers are stripped from spans on both paths. As a belt-and-suspenders backstop, enable **Prevent Storing of IP Addresses** in the Sentry project's Security & Privacy settings.

## License

MIT — see [LICENSE](LICENSE).

### Site discovery and reporting dates

Call `get_sites` without arguments to list sites authorized by the current caller's
Plausible key. Pass the returned `next_after` as `after` to retrieve subsequent pages;
a null cursor ends the list. Use `{ "site_id": "example.com" }` for a specific site,
or `{ "use_default": true }` to look up the configured server default. A default is
exposed only after an authorized API response, and list results mark it with `is_default`.

Each site includes `timezone`, `timezone_status`, and `today` (YYYY-MM-DD in that
reporting zone). Use these to resolve calendar dates; pass supported relative ranges
such as `7d` unchanged to the Stats API. Never assume the user's or server's zone.
Missing or invalid metadata returns null zone/date fields and an explicit unavailable
status. An empty available list means no sites were returned, not an API failure.

Discovery uses the read-only [Plausible Sites API](https://plausible.io/docs/sites-api)
on `PLAUSIBLE_BASE_URL`, with the same caller key as statistics queries. API permissions
and deployed versions vary: top-level `permission_denied`, `unsupported`, or
`unavailable` results include no site details. HTTP 404 is treated as unsupported
metadata (it can also mean the requested site is unavailable); it never proves that a
site exists. Discovery failures do not prevent existing statistics tools from working.

Fork-specific additions and their rationale are tracked in [FORK_CHANGES.md](FORK_CHANGES.md).

### Breakdown and conversion pagination

`get_breakdown` accepts `limit` (1–1000, default 20) and `offset` (default 0).
`get_conversions` accepts `limit` (1–10000, default 10000) and `offset` (default 0),
including when `breakdown_by_page` is enabled. Offsets are nonnegative integers.
Both request `include.total_rows` from the [Stats API](https://plausible.io/docs/stats-api).

Both text and structured results include `pagination`:

- `returned_rows`, `limit`, `offset`: describe this page.
- `total_rows`: upstream count, or null if absent/invalid.
- `has_more`: true/false when totals support a conclusion, otherwise null.
- `next_offset`: use with the same limit, filters, metrics, dimensions and dates;
  null means there is no useful next request suggested by this response.
- `completeness`: `complete` means this response contains all rows (offset zero
  and count equals the reported total); `partial` means it is only a slice;
  `unknown` means completeness cannot be verified.
- `warnings`: missing/inconsistent totals and suspected upstream caps are explicit.

For example, call `get_breakdown` with `dimension: "event:page"`, `limit: 100`,
then repeat with the returned `next_offset`. Start from offset zero and accumulate
pages to retrieve the full set. A terminal page at a nonzero offset is still partial
by itself. Missing totals remain unknown even for short or empty pages; never
present such results as exhaustive. If a cap or inconsistent response prevents
progress, report that limitation rather than claiming all rows were retrieved.

Ordering is the first requested metric descending, followed by all grouping
dimensions ascending to break ties. Counts and conversion rates retain their
original query scope. Pagination is not a snapshot: use fixed absolute dates,
and be aware that newly arriving data can move rows between requests.

### Imported historical statistics

`get_timeseries`, `get_breakdown`, `get_conversions` and `compare_periods` accept
`include_imports: true` to request imported history. Omit it or pass false for the
existing native-only default. For example:

```json
{
  "site_id": "example.com",
  "date_range": "all",
  "dimension": "visit:source",
  "include_imports": true
}
```

The tools forward this as `include.imports` to the
[Plausible Stats API](https://plausible.io/docs/stats-api), alongside pagination's
`include.total_rows` where applicable. Keep the setting the same across pages.
Plausible decides whether the requested metrics, dimensions and filters support
imports; an opt-in does not guarantee inclusion.

Text and structured results expose an `imports` coverage object when the setting
is explicit or upstream returns import metadata. It includes `requested`,
`imports_included` (true/false, or null when unconfirmed), the upstream
`imports_skip_reason` and `imports_warning` when returned, and `warnings`.
Skipped imports leave native results intact and add a visible warning. Missing
confirmation is reported as unknown coverage. Neither represents zero imported
traffic; an empty result does not establish that there was no historical traffic.

Comparisons return coverage independently under `period_a.imports` and
`period_b.imports`. Aggregates and deltas still describe returned data: check both
periods' coverage before interpreting changes, since they may cover different
sources. Calls with no inclusion setting and no upstream import metadata retain
the previous output shape.

### Upstream warnings and resolved query scope

All statistics query tools preserve Plausible's `meta` and `query` objects in
structured output as well as text output. `meta` carries upstream import coverage,
metric warnings, pagination totals and any additional metadata. `query` is the
scope actually executed by Plausible, including resolved date ranges, metrics,
dimensions and filters; it is not reconstructed from the tool arguments.

`compare_periods` preserves these objects independently under `period_a.meta`,
`period_a.query`, `period_b.meta` and `period_b.query`. Existing range labels,
aggregate metrics and deltas retain their meaning. Check each period's warnings
and resolved scope before interpreting differences. Null metrics stay null and
produce null deltas where applicable. Missing upstream objects remain absent;
explicitly returned empty objects are preserved. Unknown metadata keys and nested
warning details are retained.
