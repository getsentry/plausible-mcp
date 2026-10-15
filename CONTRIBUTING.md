# Contributing to plausible-mcp

Thanks for your interest in contributing!

## Development Setup

```bash
git clone https://github.com/getsentry/plausible-mcp.git
cd plausible-mcp
pnpm install
```

## Running Tests

```bash
pnpm test          # All tests
pnpm test:watch    # Watch mode
pnpm test:coverage # With coverage report
```

Tests use [Vitest](https://vitest.dev) with mocked `fetch` — no Plausible account needed to run them.

## Adding a New Tool

1. Create `src/tools/your-tool.ts`, starting from the closest existing tool. A tool that queries Plausible exports `register(server, client, defaultSiteId?)` — copy `get-timeseries.ts`. A tool that does not needs no client, so it exports `register(server)` — copy `send-feedback.ts`.
2. Declare an `outputSchema` and return `structuredContent` alongside the text block. Every tool does this; query-shaped results reuse `queryResultOutputSchema` and `buildQueryStructuredContent` from `src/schemas.ts`.
3. Set `annotations` to describe what the tool really does. The query tools are read-only; `send_feedback` writes to Sentry, so it sets `readOnlyHint: false`.
4. Register it in `src/server.ts`
5. Add tests in `__tests__/tools/your-tool.test.ts`
6. Add an eval case in `evals/cases.ts`. Evals grade whether a model picks the right tool from a plain-language prompt, so this applies to tools a user would ask for in words — `send_feedback` has none.

## Running LLM Evals

Requires an OpenRouter API key:

```bash
OPENROUTER_API_KEY=sk-or-... pnpm eval
```

The model defaults to `anthropic/claude-sonnet-5`; override it with `OPENROUTER_MODEL`.

## Testing the MCP Server Locally

Put your Plausible key in `.env.local` (copy `.env.example`), then:

```bash
pnpm inspect       # build + open the MCP Inspector UI, auto-connected to the server
pnpm inspect:cli   # headless: build + print the tool list (handy for a quick check or CI)
```

Both read [`mcp.json`](./mcp.json), which launches the server with
`node --env-file-if-exists=.env.local` — so your key loads from `.env.local` when it's
there, and falls back to whatever `PLAUSIBLE_API_KEY` is already in the environment when
it isn't (e.g. in CI). No need to paste it anywhere. `inspect` opens the browser UI (it
prints a pre-authed `http://localhost:6274/?...` URL); `inspect:cli` just prints
`tools/list` and exits.

## Pull Requests

- Make sure `pnpm test` passes
- Make sure `pnpm build` compiles cleanly
- Keep PRs focused — one feature or fix per PR
- Your **PR title becomes the changelog line** for the next release, so write it for a reader (see Releasing below)

## Releasing

Releases are automated with [craft](https://github.com/getsentry/craft). **Don't bump the version in `package.json` or edit `CHANGELOG.md` by hand** — both are generated.

1. Merge your PR to `main`. The changelog is auto-generated from merged PR titles since the last tag (`.craft.yml` → `changelog.policy: auto`).
2. A maintainer runs the **Release** workflow (Actions → Release → *Run workflow*) and selects the bump type (`patch` / `minor` / `major`).
3. craft cuts a `release/X.Y.Z` branch, then publishes a git tag and GitHub release once CI is green.

Deploying the Cloudflare Worker (`pnpm deploy`) is separate from cutting a release.

## Fork change log

Record every fork-specific addition, fix or behavior change in `FORK_CHANGES.md`,
including the issue, affected behavior, upstream compatibility and validation.
Keep entries with the implementation so future upstream merges can account for them.
This log is separate from the release-managed `CHANGELOG.md`.
