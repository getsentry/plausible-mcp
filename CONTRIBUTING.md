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

1. Create `src/tools/your-tool.ts` following the pattern in existing tools
2. Export a `register(server, client, defaultSiteId?)` function
3. Add `annotations: { readOnlyHint: true }` (all tools are read-only)
4. Register it in `src/server.ts`
5. Add tests in `__tests__/tools/your-tool.test.ts`
6. Add an eval case in `evals/cases.ts`

## Running LLM Evals

Requires an Anthropic API key:

```bash
ANTHROPIC_API_KEY=sk-... pnpm eval
```

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
