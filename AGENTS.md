# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, and others via the `AGENTS.md` convention) when working with code in this repository. `CLAUDE.md` is a symlink to this file.

## What This Is

MCP server for Plausible Analytics — wraps the Plausible Stats API v2 (`POST /api/v2/query`). Provides four read-only tools (`get_timeseries`, `get_breakdown`, `get_conversions`, `compare_periods`) for querying traffic and conversion data from any MCP-compatible AI tool.

Two entry points:
- **STDIO** (`src/index.ts`) — local use, reads `PLAUSIBLE_API_KEY` from env
- **Cloudflare Worker** (`src/worker.ts`) — remote, with two endpoints:
  - `/mcp` — bring-your-own-key: each user passes their own Plausible API key via `Authorization: Bearer` (header clients like Claude Code/Cursor).
  - `/internal` — for managed connectors (Cowork/Claude.ai), fronted by a Cloudflare Access application with **Managed OAuth** enabled. Access runs the OAuth 2.1 handshake with the client and forwards each request with a `Cf-Access-Jwt-Assertion` header; the Worker verifies that header (`src/cf-access.ts`), gates on `@sentry.io`, and queries a shared server-side `PLAUSIBLE_API_KEY`. The Worker itself runs **no** OAuth server — no `@cloudflare/workers-oauth-provider`, KV, or cookies.

  Managed OAuth forces the Access app to cover the **bare hostname, no path** (Cloudflare errors `domain can not have a path if oauth is configured` otherwise), so it also gates `/mcp`. A **second, path-scoped (`/mcp`) Access app with a `Bypass` policy** carves BYOK back out — most-specific path wins. This is Cloudflare-side config, not code; see README "Setting up the `/internal` endpoint" for the full two-app setup and troubleshooting table.

## Commands

```bash
pnpm install             # Install dependencies
pnpm build               # TypeScript compilation (tsc)
pnpm dev                 # Run locally via STDIO (tsx)
pnpm test                # Run all tests (vitest)
pnpm test:watch          # Watch mode
pnpm test __tests__/tools/get-timeseries.test.ts  # Single test file
pnpm deploy              # Deploy to Cloudflare Workers (includes Sentry sourcemaps)

# LLM evals (requires ANTHROPIC_API_KEY)
ANTHROPIC_API_KEY=sk-... pnpm eval

# Test with MCP Inspector
pnpm build && PLAUSIBLE_API_KEY=your-key npx @modelcontextprotocol/inspector node dist/index.js
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

Tests use Vitest with mocked `fetch` — no Plausible account needed. Test helpers are in `__tests__/tools/_helpers.ts` (`createMockClient`, `getToolHandler`). The Cloudflare-specific worker files (`worker.ts`, `env.ts`, `cf-access.ts`) are excluded from the default `tsconfig.json` (they use Cloudflare/Workers globals, not Node), and are type-checked separately via `pnpm typecheck` (`tsconfig.worker.json`, which swaps in `@cloudflare/workers-types`).

## Releasing

Releases are automated with [craft](https://github.com/getsentry/craft) — **do not hand-edit the version in `package.json` or add entries to `CHANGELOG.md`**. Both are produced by the release pipeline.

1. Land your change on `main` via a PR. The **PR title becomes the changelog line** (`.craft.yml` sets `changelog.policy: auto`, which generates the changelog from merged PRs since the last tag).
2. Run the **Release** GitHub Action (`.github/workflows/release.yml`, `workflow_dispatch`) and pick the bump — `patch` / `minor` / `major`.
3. `getsentry/action-prepare-release` computes the next version, opens a `release/X.Y.Z` branch, and craft publishes a git tag + GitHub release (`artifactProvider: none` — no build artifacts uploaded). CI must be green on the release commit or the publish gate stalls.

`pnpm deploy` (Cloudflare Worker + Sentry sourcemap upload via `@sentry/cli`) is a **separate** step from cutting a release.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PLAUSIBLE_API_KEY` | Yes (STDIO; also Worker `/internal`) | Plausible API key. On the Worker it's the shared key used by the `/internal` endpoint (the `/mcp` BYOK endpoint takes the user's key via Bearer). |
| `PLAUSIBLE_BASE_URL` | No | Custom Plausible instance URL (default: `https://plausible.io`) |
| `PLAUSIBLE_DEFAULT_SITE_ID` | No | Default site domain to avoid passing `site_id` every call |

Worker `/internal` (Cloudflare Access Managed OAuth) also needs these secrets — see README "Setting up the `/internal` endpoint":

| Variable | Description |
|----------|-------------|
| `CF_ACCESS_TEAM_DOMAIN` | `https://<team>.cloudflareaccess.com` — verifies the `Cf-Access-Jwt-Assertion` JWKS + issuer (no trailing slash) |
| `CF_ACCESS_AUD` | The Access application's Application Audience (AUD) tag — checked against the assertion `aud` |
| `ALLOWED_EMAIL_DOMAIN` (var, optional) | Comma-separated email domain(s) gating `/internal` login. Defaults to `sentry.io`; the `@sentry.io` gate is **not** hardcoded — self-hosters set their own domain |
