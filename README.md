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

All tools are **read-only** and annotated with `readOnlyHint: true`.

## Quick Start

### Remote (Hosted)

A hosted instance is available at **`https://plausible-mcp.sentry.dev`**.

**With your own Plausible API key** (any user):

```bash
claude mcp add plausible --transport http --header "Authorization: Bearer YOUR_PLAUSIBLE_API_KEY" https://plausible-mcp.sentry.dev/mcp
```

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
- **`/internal`** — OAuth 2.1 server for managed connectors (Cowork, Claude.ai). Federates login to Cloudflare Access and queries a shared, server-side Plausible API key.

#### Setting up the `/internal` OAuth endpoint

1. **Create the KV namespace** (stores OAuth tokens/grants/state) and paste the id into `wrangler.toml`:
   ```bash
   npx wrangler kv namespace create OAUTH_KV
   ```
2. **Register a Cloudflare Access SaaS app** (Zero Trust → Access → Applications → *Add an application* → *SaaS* → **OIDC**):
   - **Redirect URL**: `https://<your-worker-host>/callback`
   - Scopes: `openid`, `email`, `profile`
   - Add an Access **policy** restricting to your email domain (e.g. `@sentry.io`) and your identity provider (Google SSO).
   - Copy the **Client ID**, **Client secret**, **Authorization endpoint**, and **Token endpoint**.
3. **Set the worker secrets**:
   ```bash
   npx wrangler secret put CF_ACCESS_TEAM_DOMAIN      # https://<team>.cloudflareaccess.com
   npx wrangler secret put ACCESS_CLIENT_ID
   npx wrangler secret put ACCESS_CLIENT_SECRET
   npx wrangler secret put ACCESS_AUTHORIZATION_URL
   npx wrangler secret put ACCESS_TOKEN_URL
   npx wrangler secret put COOKIE_ENCRYPTION_KEY      # openssl rand -hex 32
   npx wrangler secret put PLAUSIBLE_API_KEY          # shared key for /internal queries
   ```
4. **Set `SERVICE_HOSTNAME`** in `wrangler.toml` `[vars]` to your worker host (the default is `plausible-mcp.sentry.dev`). It pins the accepted Host on the OAuth authorize/callback endpoints; remove it to disable that check.
5. **Deploy** (`npx wrangler deploy`), then point an OAuth MCP client at `https://<your-worker-host>/internal`.

## Configuration

| Environment Variable | Required | Default | Description |
|---------------------|----------|---------|-------------|
| `PLAUSIBLE_API_KEY` | Yes (STDIO) | — | Your Plausible API key ([get one here](https://plausible.io/docs/stats-api)) |
| `PLAUSIBLE_BASE_URL` | No | `https://plausible.io` | URL of your Plausible instance (for self-hosted) |
| `PLAUSIBLE_DEFAULT_SITE_ID` | No | — | Default site domain so you don't have to pass `site_id` every call |

For the Cloudflare Worker, `PLAUSIBLE_API_KEY` is not needed as an env var — each user passes their own key via the `Authorization: Bearer` header.

## Plausible API

This server wraps the [Plausible Stats API v2](https://plausible.io/docs/stats-api) (`POST /api/v2/query`). It works with both [Plausible Cloud](https://plausible.io) and [self-hosted](https://plausible.io/docs/self-hosting) instances.

### Supported Metrics

`visitors`, `visits`, `pageviews`, `views_per_visit`, `bounce_rate`, `visit_duration`, `events`, `scroll_depth`, `percentage`, `conversion_rate`, `group_conversion_rate`, `average_revenue`, `total_revenue`, `time_on_page`

### Supported Dimensions

`event:page`, `event:goal`, `event:hostname`, `visit:entry_page`, `visit:exit_page`, `visit:source`, `visit:referrer`, `visit:channel`, `visit:utm_medium`, `visit:utm_source`, `visit:utm_campaign`, `visit:utm_content`, `visit:utm_term`, `visit:device`, `visit:browser`, `visit:browser_version`, `visit:os`, `visit:os_version`, `visit:country`, `visit:region`, `visit:city`

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

## License

MIT — see [LICENSE](LICENSE).
