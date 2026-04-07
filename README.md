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

A hosted instance is available at **`https://plausible-mcp.serg.tech`**. Each user provides their own Plausible API key as a Bearer token — no setup required.

Add to Claude Code:

```bash
claude mcp add plausible --transport http https://plausible-mcp.serg.tech
```

When prompted for authentication, use your Plausible API key as the Bearer token.

### Local (STDIO)

If you prefer to run it locally:

```bash
git clone https://github.com/getsentry/plausible-mcp.git
cd plausible-mcp
bun install
```

Add to Claude Code:

```bash
claude mcp add plausible -e PLAUSIBLE_API_KEY=your-key -- bun run src/index.ts
```

Or Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "plausible": {
      "command": "bun",
      "args": ["run", "/path/to/plausible-mcp/src/index.ts"],
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
bun install
npx wrangler deploy
```

The worker is multi-tenant — each user passes their own Plausible API key via the `Authorization: Bearer` header. No shared secrets needed on the server.

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
bun install
bun run build      # TypeScript compilation
bun run test       # Run 53 unit + integration tests
bun run test:watch # Watch mode
```

### Testing with MCP Inspector

```bash
PLAUSIBLE_API_KEY=your-key npx @modelcontextprotocol/inspector bun run src/index.ts
```

### LLM Evals

Verifies Claude picks the right tool for natural language analytics questions:

```bash
ANTHROPIC_API_KEY=sk-... bun run eval
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
