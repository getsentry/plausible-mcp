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

## Reviewing MCP Apps results

Run `pnpm review:ui` and open `coverage/ui-review/index.html` in a browser. The preview loads the same HTML that clients read from the MCP server. Choose a tool, then a result or lifecycle state. Switch the theme and width to check the same view at 320 px or full width. The theme control changes the host page and the host context together, as a real host does, and the host sends the spec's standard style variables. Add `?no-host-styles` to the URL to check a host that sends no `styles`. It works offline with fixture analytics and feedback data. Open the adjacent `landing.html` to try the public installation page and its embedded traffic chart. Both documents are included in the CI review artifact.

To run the browser checks, install Chromium and WebKit with `pnpm exec playwright install --only-shell chromium webkit`. Run `pnpm test:ui` to build the preview and test it in Chromium and WebKit with the MCP Apps SDK host bridge. The checks cover all five tools, error and empty results, keyboard inspection, table paging, and host theme and size changes. For each tool, on light and dark devices and hosts, they compare the painted pixels with the host surface and check that the text has at least 4.5:1 contrast. The landing page chart gets the same check. Each of these checks saves a screenshot in `coverage/ui-review/screens/`. CI also publishes the preview and the screenshots as the **mcp-apps-preview** artifact, also when a check fails. Look at the screenshots of each PR that changes `src/ui`.

The view does not use the SDK's `App` class, so it must do what the SDK helpers do for a View. Follow "View Behavior" in the [MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx). For example, `applyDocumentTheme` sets the theme on the document root, not on an element. If the color scheme of a document root differs from that of its iframe element, the browser paints an opaque background in the document's scheme. The sandbox proxy applies the theme that it relays to its own root, so the host, the proxy and the view always use the same scheme.

To check the deployed hostname before launch, run `pnpm verify:hosted --baseline`. After the Worker release and the exact-root Access override, run `pnpm verify:hosted` from the released commit. The check verifies the landing document, bearer challenge, OAuth challenge, and discovery metadata. Set `PLAUSIBLE_API_KEY` and `PLAUSIBLE_SITE_ID` and add `--read` to check authenticated discovery, read the shipped app after launch, and query traffic. Also run a traffic query through an existing SSO connector to check the authenticated `/internal` path. The checker prints no analytics rows or credentials.

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
4. The published GitHub release starts the **Deploy** workflow. It deploys the Worker from the tag and uploads its sourcemaps to Sentry, using the `CLOUDFLARE_API_TOKEN` and `SENTRY_AUTH_TOKEN` secrets of the `production` environment.

5. For a release that changes `src/ui`, open one tool result in Claude.ai in the light theme and in the dark theme after the deploy. Compare it with the CI screenshots. If it is different, roll back.

To redeploy or roll back, run the **Deploy** workflow by hand with a release tag. This works only for tags that contain `bin/deploy-worker.sh`. `pnpm run deploy:worker` does the same deploy from a local checkout. Use `pnpm run`: `pnpm deploy` is a built-in pnpm command, not this script.
