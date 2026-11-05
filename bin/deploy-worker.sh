#!/bin/bash
# Deploys the Worker, then records the release in Sentry with its sourcemaps.
# Credentials: CLOUDFLARE_API_TOKEN and SENTRY_AUTH_TOKEN in CI; locally,
# `wrangler login` and `sentry auth login` work instead.
set -euo pipefail

VERSION=$(node -p "require('./package.json').version")
OUT_DIR=.sentry-build
export SENTRY_ORG=sentry-developer-experience
export SENTRY_PROJECT=plausible-mcp

rm -rf "$OUT_DIR"
pnpm exec wrangler deploy --outdir "$OUT_DIR" --var "SENTRY_RELEASE:$VERSION"

# --no-rewrite: the deployed bundle has no debug IDs, so the upload must not add
# them either; Sentry matches frames to these sourcemaps by release and file name.
pnpm exec sentry release create "$VERSION"
pnpm exec sentry sourcemap upload "$OUT_DIR" --release "$VERSION" --no-rewrite
pnpm exec sentry release finalize "$VERSION"
pnpm exec sentry release deploy "$VERSION" production

rm -rf "$OUT_DIR"
