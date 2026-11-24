// Read-only release smoke. Print only call counts, timings and outcome.
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createTestHarness } from "wrangler";

const mode = process.argv[2] ?? "stdio";
assert.ok(["stdio", "worker", "hosted"].includes(mode), "Choose stdio, worker or hosted.");
const key = process.env.PLAUSIBLE_API_KEY;
assert.ok(key, "Set PLAUSIBLE_API_KEY.");
const harness =
  mode === "worker"
    ? createTestHarness({ workers: [{ configPath: "./wrangler.toml" }] })
    : undefined;
const endpoint = new URL("https://plausible-mcp.sentry.dev/mcp");
const client = new Client(
  { name: "plausible-reports-check", version: "1" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);
const transport =
  mode === "stdio"
    ? new StdioClientTransport({
        command: process.execPath,
        args: ["dist/index.js"],
        env: { PLAUSIBLE_API_KEY: key },
      })
    : new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { Authorization: "Bearer " + key } },
        ...(harness && { fetch: (url, init) => harness.fetch(String(url), init) }),
      });

async function call(name, args) {
  const start = performance.now();
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const detail = result.content.find(
      (block) => block.type === "text" && block.text.startsWith('{"error":'),
    );
    const info = detail && JSON.parse(detail.text).error;
    const status = info?.message.match(/(?:returned |\()([45]\d\d)/)?.[1];
    throw Error(
      name + " failed (" + (info?.code ?? "validation") + (status ? " HTTP " + status : "") + ")",
    );
  }
  assert.ok(result.structuredContent, name + " returned no structured data");
  console.log("PASS", name, Math.round(performance.now() - start) + " ms");
  return result.structuredContent;
}

// Use completed dates so a new visit cannot change one side of the comparison.
async function compareReferralReports(site_id) {
  const dates = [30, 1].map((days) =>
    new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10),
  );
  const base = { site_id, metrics: ["visits"] };
  const channel = { property: "visit:channel", values: ["AI Assistants"] };
  const breakdown = { ...base, date_range: dates.join(","), property_filters: [channel] };
  const started = performance.now();
  const sources = await call("get_breakdown", {
    ...breakdown,
    dimension: "visit:source",
    limit: 5,
  });
  assert.ok(
    !sources.pagination.has_more,
    "Choose a smaller site for this bounded benchmark (up to five referring assistants).",
  );
  const pages = await Promise.all(
    sources.results.map(async ({ dimensions: [source] }) => {
      const result = await call("get_breakdown", {
        ...breakdown,
        dimension: "visit:entry_page",
        limit: 1000,
        property_filters: [channel, { property: "visit:source", values: [source] }],
      });
      assert.ok(
        !result.pagination.has_more,
        "Choose a site with fewer than 1,001 landing pages per assistant.",
      );
      return result.results.map(({ dimensions: [page], metrics: [visits] }) =>
        JSON.stringify([source, page, visits]),
      );
    }),
  );
  const breakdownMs = Math.round(performance.now() - started);
  const queryStart = performance.now();
  const result = await call("query_stats", {
    ...base,
    date_range: dates,
    dimensions: ["visit:source", "visit:entry_page"],
    filters: [["is", "visit:channel", channel.values]],
    pagination: { limit: 1000 },
  });
  const queryMs = Math.round(performance.now() - queryStart);
  assert.ok(
    !result.pagination.has_more,
    "Choose a site with fewer than 1,001 assistant and page pairs.",
  );
  const actual = result.results
    .map(({ dimensions, metrics }) => JSON.stringify([...dimensions, ...metrics]))
    .sort();
  const expected = pages.flat().sort();
  assert.ok(JSON.stringify(actual) === JSON.stringify(expected), "Report rows or counts differ.");
  console.log(
    "Identical referral rows:",
    actual.length,
    "breakdown calls:",
    1 + pages.length,
    "in",
    breakdownMs,
    "ms; query calls: 1 in",
    queryMs,
    "ms",
  );
}

try {
  await harness?.listen();
  await client.connect(transport);
  const tools = await client.listTools();
  const resources = await client.listResources();
  const prompts = await client.listPrompts();
  assert.ok(prompts.prompts.some((p) => p.name === "ai-referrals"));
  assert.ok((await client.getPrompt({ name: "ai-referrals" })).messages.length);
  const schema = await client.readResource({ uri: "plausible://reference/stats-query" });
  assert.ok(JSON.parse(schema.contents[0].text).definitions.filter_tree);
  console.log(
    "PASS discovery",
    tools.tools.length,
    "tools,",
    resources.resources.length,
    "resources,",
    prompts.prompts.length,
    "prompts",
  );

  const sites = await call("list_sites", {});
  const site_id = process.env.PLAUSIBLE_SITE_ID ?? sites.sites[0]?.domain;
  assert.ok(site_id, "Set PLAUSIBLE_SITE_ID to a site this key can query.");
  if (process.argv.includes("--compare")) await compareReferralReports(site_id);
  await call("get_site_metadata", { site_id, kind: "custom_properties" });
  const goals = await call("get_site_metadata", { site_id, kind: "goals" });
  const date_range = "30d";
  const query = { site_id, date_range, metrics: ["visits"] };
  const filter = { property: "visit:channel", values: ["AI Assistants"] };
  for (const dimension of ["visit:source", "visit:entry_page"]) {
    const result = await call("get_breakdown", {
      ...query,
      dimension,
      property_filters: [filter],
      limit: 3,
    });
    assert.ok(
      result.results.every((r) => r.dimensions.length === 1 && Number.isFinite(r.metrics[0])),
    );
  }
  const advanced = await call("query_stats", {
    ...query,
    dimensions: ["visit:source", "visit:entry_page"],
    filters: [["is", "visit:channel", ["AI Assistants"]]],
    include: { total_rows: true },
    pagination: { limit: 3 },
  });
  assert.ok(
    advanced.results.length <= 3 && advanced.results.every((r) => r.dimensions.length === 2),
  );
  assert.ok(Number.isInteger(advanced.meta.total_rows));
  assert.deepEqual(advanced.pagination, {
    limit: 3,
    offset: 0,
    has_more: advanced.meta.total_rows > 3,
  });
  const dates = Array.from({ length: 4 }, (_, i) =>
    new Date(Date.now() - (4 - i) * 86400000).toISOString().slice(0, 10),
  );
  const periods = {
    site_id,
    period_a: dates.slice(0, 2).join(","),
    period_b: dates.slice(2).join(","),
  };
  const ranked = await call("compare_breakdown", {
    ...periods,
    dimension: "visit:source",
    direction: "losses",
  });
  assert.ok(ranked.results.every((r) => r.after - r.before === r.change && r.change < 0));
  const goal = goals.goals?.[0]?.display_name;
  if (goal) {
    const money = await call("get_breakdown", {
      site_id,
      date_range,
      dimension: "visit:utm_source",
      goal,
      metrics: ["total_revenue"],
      limit: 3,
    });
    assert.ok(
      money.results.every((r) => r.metrics[0] === null || Number.isFinite(r.metrics[0]?.value)),
    );
    console.log(
      "Revenue observations",
      money.results.filter((r) => r.metrics[0]?.currency).length,
      "with currency",
    );
  }
} finally {
  await client.close();
  await harness?.close();
}
