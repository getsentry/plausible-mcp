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

If you prefer to run it locally:

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
   npx wrangler secret put CF_ACCESS_TEAM_DOMAIN      # https://<team>.cloudflareaccess.com  (no trailing slash)
   npx wrangler secret put CF_ACCESS_AUD              # the Managed OAuth application's AUD tag (from step 1)
   npx wrangler secret put PLAUSIBLE_API_KEY          # shared key for /internal queries
   ```
4. **Set the `[vars]` in `wrangler.toml`**:
   - `ALLOWED_EMAIL_DOMAIN` — the email domain(s) allowed to sign in, comma-separated, `@` optional (default `sentry.io`). Enforced in code **in addition to** the Access policy in step 1, so set it to your own domain — otherwise every login is rejected.
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
| `PLAUSIBLE_API_KEY` | Yes (STDIO) | — | Your Plausible API key ([get one here](https://plausible.io/docs/stats-api)) |
| `PLAUSIBLE_BASE_URL` | No | `https://plausible.io` | URL of your Plausible instance (for self-hosted) |
| `PLAUSIBLE_DEFAULT_SITE_ID` | No | — | Default site domain so you don't have to pass `site_id` every call |
| `CF_ACCESS_TEAM_DOMAIN` | Yes (Worker `/internal`) | — | `https://<team>.cloudflareaccess.com` — verifies the `Cf-Access-Jwt-Assertion` JWKS + issuer. No trailing slash. |
| `CF_ACCESS_AUD` | Yes (Worker `/internal`) | — | The Access application's Application Audience (AUD) tag — checked against the assertion's `aud`. |
| `SENTRY_DSN` | No (Worker) | — | Sentry DSN for the Worker's own telemetry (`wrangler secret put SENTRY_DSN`). Unset disables Sentry — use your own DSN if you want telemetry on a self-hosted deployment. |
| `ALLOWED_EMAIL_DOMAIN` | No (Worker `/internal`) | `sentry.io` | Comma-separated email domain(s) allowed to sign in to `/internal`. Set to your own domain when self-hosting. |

On the Worker, the `/mcp` endpoint needs no server-side key — each user passes their own via `Authorization: Bearer`. The `/internal` endpoint is fronted by Cloudflare Access Managed OAuth and uses a shared server-side `PLAUSIBLE_API_KEY` secret (see [self-hosting](#setting-up-the-internal-endpoint-cloudflare-access-managed-oauth)).

## Plausible API

This server wraps the [Plausible Stats API v2](https://plausible.io/docs/stats-api) (`POST /api/v2/query`). It works with both [Plausible Cloud](https://plausible.io) and [self-hosted](https://plausible.io/docs/self-hosting) instances.

### Supported Metrics

`visitors`, `visits`, `pageviews`, `views_per_visit`, `bounce_rate`, `visit_duration`, `events`, `scroll_depth`, `percentage`, `conversion_rate`, `group_conversion_rate`, `average_revenue`, `total_revenue`, `time_on_page`

### Supported Dimensions

`event:page`, `event:goal`, `event:hostname`, `visit:entry_page`, `visit:exit_page`, `visit:source`, `visit:referrer`, `visit:channel`, `visit:utm_medium`, `visit:utm_source`, `visit:utm_campaign`, `visit:utm_content`, `visit:utm_term`, `visit:device`, `visit:browser`, `visit:browser_version`, `visit:os`, `visit:os_version`, `visit:country`, `visit:region`, `visit:city`, `visit:country_name`, `visit:region_name`, `visit:city_name`

The `*_name` geography dimensions return human-readable names (e.g. "Canada"); the plain `visit:country`/`region`/`city` return ISO/Geoname codes.

### Custom Properties

Sites send their own [custom event properties](https://plausible.io/docs/custom-props/introduction), addressed as `event:props:<name>`. These are site-specific, so there's no fixed list.

- **Break down by** a custom property: pass `get_breakdown` a `dimension` of `event:props:<name>` (e.g. `event:props:plan`).
- **Filter by** a custom property on any query tool via `property_filters`, e.g. `[{ "property": "plan", "operator": "is", "values": ["pro"] }]`. The `property` is the bare name (no `event:props:` prefix); operators are `is`, `is_not`, `contains`, `contains_not`, and multiple entries combine with AND.

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

Verifies Claude picks the right tool for natural language analytics questions:

```bash
ANTHROPIC_API_KEY=sk-... pnpm eval
```

## Architecture

```
src/
├── index.ts              # STDIO entry point (local use)
├── worker.ts             # Cloudflare Worker entry point (remote)
├── server.ts             # Creates McpServer, registers all tools
├── plausible.ts          # PlausibleClient — standalone API client
├── schemas.ts            # Shared Zod schemas and filter helpers
└── tools/
    ├── get-timeseries.ts
    ├── get-breakdown.ts
    ├── get-conversions.ts
    └── compare-periods.ts
```

`PlausibleClient` has zero MCP dependency and can be used standalone.

### Observability & data collection

The Worker reports to Sentry with an endpoint-dependent privacy posture:

- **`/mcp` (bring-your-own-key)** — fully anonymous. Tool inputs and outputs are **not** recorded (that data belongs to the caller and their own key), no identity is attached, and the ingest-inferred client IP is stripped (`src/redaction.ts`). Only operational telemetry remains: tool names, span timings, and failures.
- **`/internal` (SSO-gated)** — attributed. Requests carry the authenticated `@sentry.io` email (`Sentry.setUser`), and tool inputs/outputs **are** recorded (`recordToolIO`) for attribution and abuse-tracing on the shared server-side key.

`Authorization` / `Cookie` / `Cf-Access-Jwt-Assertion` headers are stripped from spans on both paths. As a belt-and-suspenders backstop, enable **Prevent Storing of IP Addresses** in the Sentry project's Security & Privacy settings.

## License

MIT — see [LICENSE](LICENSE).
