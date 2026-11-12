import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { landingHtml } from "../dist/landing.js";

const origin = "https://plausible-mcp.sentry.dev";
const baseline = process.argv.includes("--baseline");
const checkData = process.argv.includes("--read");

async function check(name, fn) {
  try {
    await fn();
    console.log("PASS", name);
  } catch (error) {
    process.exitCode = 1;
    console.error("FAIL", name, "—", error.message);
  }
}
const read = path => fetch(new URL(path, origin), {redirect: "manual", signal: AbortSignal.timeout(10000)});

await check(baseline ? "root challenges before launch" : "root serves the built landing page", async () => {
  const r = await read("/");
  if (baseline) {
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") ?? "", /resource_metadata=/);
  } else {
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /^text\/html/i);
    assert.ok((await r.text()) === landingHtml, "Response differs from this build's landing HTML");
  }
});

await check("public MCP requires a Plausible bearer key", async () => {
  const r = await read("/mcp");
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate") ?? "", /Bearer realm="plausible-mcp"/);
});

await check("internal MCP challenges and advertises the configured OAuth issuer", async () => {
  const r = await read("/internal");
  assert.equal(r.status, 401);
  const match = /resource_metadata="([^"]+)"/.exec(r.headers.get("www-authenticate") ?? "");
  assert.ok(match, "Missing protected-resource metadata URL");
  const endpoint = new URL(match[1]);
  assert.equal(endpoint.origin, origin);
  const [resource, authorization] = await Promise.all([read(endpoint.pathname), read("/.well-known/oauth-authorization-server")]);
  assert.equal(resource.status, 200);
  assert.equal(authorization.status, 200);
  const protectedResource = await resource.json();
  const { issuer, authorization_endpoint, token_endpoint } = await authorization.json();
  assert.equal(issuer, "https://sentry-internal.cloudflareaccess.com");
  assert.ok(protectedResource.authorization_servers?.includes(issuer), "OAuth metadata issuer mismatch");
  for (const url of [authorization_endpoint, token_endpoint]) assert.equal(new URL(url).protocol, "https:");
});

if (checkData) await check("authenticated tool discovery and read-only traffic query", async () => {
  const key = process.env.PLAUSIBLE_API_KEY;
  const site = process.env.PLAUSIBLE_SITE_ID;
  assert.ok(key && site, "Set PLAUSIBLE_API_KEY and PLAUSIBLE_SITE_ID to run --read");
  const client = new Client({ name: "plausible-release-check", version: "1" }, {
    capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
  });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", origin), {
      requestInit: { headers: { Authorization: "Bearer " + key } },
    }));
    const { tools } = await client.listTools();
    const traffic = tools.find(tool => tool.name === "get_timeseries");
    assert.ok(traffic, "Missing traffic tool");
    if (!baseline) {
      const uri = traffic._meta?.ui?.resourceUri;
      assert.ok(uri?.startsWith("ui://"), "Missing analytics resource");
      for (const name of ["get_breakdown", "get_conversions", "compare_periods", "send_feedback"]) {
        assert.equal(tools.find(tool => tool.name === name)?._meta?.ui?.resourceUri, uri, name);
      }
      const { contents } = await client.readResource({ uri });
      assert.equal(contents[0]?.mimeType, "text/html;profile=mcp-app");
      assert.ok(contents[0].text?.includes("ui/initialize"), "Missing UI handshake");
    }
    const result = await client.callTool({
      name: traffic.name,
      arguments: { site_id: site, date_range: "7d", metrics: ["visitors"] },
    });
    assert.ok(!result.isError && Array.isArray(result.structuredContent?.results), "Traffic query did not return rows");
  } finally { await client.close(); }
});
