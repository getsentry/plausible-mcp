#!/usr/bin/env node
// Post-deploy smoke test for the Cloudflare Worker.
// Runs the MCP `initialize` handshake against the live /mcp endpoint and asserts
// the worker is reachable and reports the expected version. Exits non-zero on
// failure so CI can roll back.
//
// Scope: initialize only. It confirms the deploy is live and running the right
// build. It deliberately does NOT call tools/list — that path validates the
// bearer as a Plausible API key, so it would need a real key + live site to
// exercise, and tool registration is already covered by the unit tests.
//
// Usage: node bin/smoke.mjs [url] [expectedVersion]
//   url             defaults to $SMOKE_URL or https://plausible-mcp.sentry.dev/mcp
//   expectedVersion defaults to $SMOKE_EXPECTED_VERSION (optional; skipped if unset)

const URL =
  process.argv[2] || process.env.SMOKE_URL || "https://plausible-mcp.sentry.dev/mcp";
const EXPECTED = process.argv[3] || process.env.SMOKE_EXPECTED_VERSION || null;
// initialize never calls Plausible, so any bearer works for a liveness check.
const BEARER = process.env.SMOKE_BEARER || "smoke-test";

function fail(msg) {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
}

console.log(`Smoke testing ${URL}${EXPECTED ? ` (expecting v${EXPECTED})` : ""}`);

const res = await fetch(URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${BEARER}`,
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "ci-smoke", version: "1" },
    },
  }),
});

if (!res.ok) fail(`initialize returned HTTP ${res.status}`);

// Response is an SSE stream ("data: {json}"); pull the JSON-RPC frame out.
const text = await res.text();
const frame = text
  .split("\n")
  .map((l) => l.match(/^data:\s*(.+)$/)?.[1])
  .filter(Boolean)
  .map((j) => {
    try {
      return JSON.parse(j);
    } catch {
      return null;
    }
  })
  .find((m) => m?.id === 1);

const serverInfo = frame?.result?.serverInfo;
if (!serverInfo) fail(`no serverInfo in response: ${text.slice(0, 200)}`);
console.log(`serverInfo: ${serverInfo.name} v${serverInfo.version}`);
if (serverInfo.name !== "plausible-mcp") fail(`unexpected name "${serverInfo.name}"`);
if (EXPECTED && serverInfo.version !== EXPECTED)
  fail(`version mismatch: live=${serverInfo.version} expected=${EXPECTED}`);

console.log("SMOKE OK");
