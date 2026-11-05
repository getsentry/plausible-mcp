#!/bin/bash
# Deploys the Worker and records the release in Sentry with its sourcemaps.
# Credentials: CLOUDFLARE_API_TOKEN and SENTRY_AUTH_TOKEN in CI; locally,
# `wrangler login` and `sentry auth login` work instead.
set -euo pipefail

VERSION=$(node -p "require('./package.json').version")
OUT_DIR=.sentry-build
export SENTRY_ORG=sentry-developer-experience
export SENTRY_PROJECT=plausible-mcp

# Build without deploying, so a failed Sentry upload stops the deploy before the
# Worker goes live without its sourcemaps.
rm -rf "$OUT_DIR"
pnpm exec wrangler deploy --dry-run --outdir "$OUT_DIR" --var "SENTRY_RELEASE:$VERSION"

# --no-rewrite: the deployed bundle has no debug IDs, so the upload must not add
# them either; Sentry matches frames to these sourcemaps by release and file name.
pnpm exec sentry release create "$VERSION" --project "$SENTRY_PROJECT"
pnpm exec sentry sourcemap upload "$OUT_DIR" --release "$VERSION" --no-rewrite

# --no-bundle deploys the exact bundle whose sourcemaps were uploaded.
pnpm exec wrangler deploy "$OUT_DIR/worker.js" --config wrangler.toml --no-bundle \
  --var "SENTRY_RELEASE:$VERSION"
pnpm exec sentry release finalize "$VERSION"
pnpm exec sentry release deploy "$VERSION" production

rm -rf "$OUT_DIR"
