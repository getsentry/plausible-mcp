# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

MCP server for Plausible Analytics — wraps the Plausible Stats API v2 (`POST /api/v2/query`). Provides four read-only tools (`get_timeseries`, `get_breakdown`, `get_conversions`, `compare_periods`) for querying traffic and conversion data from any MCP-compatible AI tool.

Two entry points:
- **STDIO** (`src/index.ts`) — local use, reads `PLAUSIBLE_API_KEY` from env
- **Cloudflare Worker** (`src/worker.ts`) — multi-tenant remote, each user passes their own API key via `Authorization: Bearer` header

## Commands

```bash
bun install              # Install dependencies
bun run build            # TypeScript compilation (tsc)
bun run dev              # Run locally via STDIO
bun run test             # Run all tests (vitest)
bun run test:watch       # Watch mode
bun run test -- __tests__/tools/get-timeseries.test.ts  # Single test file
bun run deploy           # Deploy to Cloudflare Workers — passes package.json version as SENTRY_RELEASE

# LLM evals (requires ANTHROPIC_API_KEY)
ANTHROPIC_API_KEY=sk-... bun run eval

# Test with MCP Inspector
PLAUSIBLE_API_KEY=your-key npx @modelcontextprotocol/inspector bun run src/index.ts
```

## Architecture

`PlausibleClient` (`src/plausible.ts`) is a standalone API client with zero MCP dependency. Each tool in `src/tools/` exports a `register(server, client, defaultSiteId?)` function that registers itself on the `McpServer`. `src/server.ts` wires them together via `createServer()`.

The worker (`src/worker.ts`) creates a fresh server per request using the caller's Bearer token. Sentry instrumentation wraps the worker and each tool handler has its own Sentry span.

Shared Zod schemas and filter builders live in `src/schemas.ts`. Plausible filters use array format: `["is", "event:page", ["/pricing"]]` or `["contains", "event:page", ["/blog"]]` for wildcard.

## Adding a New Tool

1. Create `src/tools/your-tool.ts` with `export function register(server, client, defaultSiteId?)`
2. Add `annotations: { readOnlyHint: true }` (all tools are read-only)
3. Register it in `src/server.ts`
4. Add tests in `__tests__/tools/your-tool.test.ts`
5. Add eval cases in `evals/cases.ts`

## Testing

Tests use Vitest with mocked `fetch` — no Plausible account needed. Test helpers are in `__tests__/tools/_helpers.ts` (`createMockClient`, `getToolHandler`). The `worker.ts` entry point is excluded from `tsconfig.json` (it uses Cloudflare-specific types).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PLAUSIBLE_API_KEY` | Yes (STDIO only) | Plausible API key |
| `PLAUSIBLE_BASE_URL` | No | Custom Plausible instance URL (default: `https://plausible.io`) |
| `PLAUSIBLE_DEFAULT_SITE_ID` | No | Default site domain to avoid passing `site_id` every call |
