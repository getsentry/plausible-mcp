# Contributing to plausible-mcp

Thanks for your interest in contributing!

## Development Setup

```bash
git clone https://github.com/sergical/plausible-mcp.git
cd plausible-mcp
bun install
```

## Running Tests

```bash
bun run test          # All tests
bun run test:watch    # Watch mode
bun run test:coverage # With coverage report
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
ANTHROPIC_API_KEY=sk-... bun run eval
```

## Testing the MCP Server Locally

```bash
PLAUSIBLE_API_KEY=your-key npx @modelcontextprotocol/inspector bun run src/index.ts
```

## Pull Requests

- Make sure `bun run test` passes
- Make sure `bun run build` compiles cleanly
- Keep PRs focused — one feature or fix per PR
