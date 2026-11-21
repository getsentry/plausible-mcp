MCP server wrapping the Plausible Stats API v2. Two entry points — STDIO (`src/index.ts`) and a Cloudflare Worker (`src/worker.ts`) — so a change to shared code usually needs both checked.

## Before calling a change green

`pnpm build` does not typecheck the Worker. `worker.ts`, `env.ts` and `cf-access.ts` use Workers globals rather than Node ones, so `tsconfig.json` excludes them and `pnpm typecheck` covers them through `tsconfig.worker.json`. Run both, plus `pnpm test`.

craft owns the version in `package.json` and every `CHANGELOG.md` line — leave both to the release pipeline.

## Reference

- **Sentry, spans, metrics, or anything user-identifying** — `TELEMETRY.md`, which owns the privacy posture: `/mcp` anonymous, `/internal` attributed.
- **Deploying, or the Worker's auth and endpoints** — README "Self-Hosting". `SENTRY_DSN` stays an uncommitted secret; a hardcoded one once had forks of this public repo reporting into our Sentry project.
- **Writing or changing a test** — CONTRIBUTING.md "Writing tests".
- Scripts are in `package.json`, environment variables in README "Configuration", contributor procedure in `CONTRIBUTING.md`.
