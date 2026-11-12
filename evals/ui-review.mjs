// Run after pnpm build. Only Plausible's upstream HTTP responses are fixtures:
// discovery, tool validation, handlers, output schemas and resource reads are real.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../dist/server.js";
import { build } from "esbuild";
import { landingHtml } from "../dist/landing.js";

const days = [188, 215, 193, 254, 231, 205, 262, 279, 238, 246, 305, 277, 314, 327];
const scores = [52, 45, 49, 43, 46, 47, 44, 43, 45, 48, 42, 44, 41, 38];
const period = { site_id: "example.com", date_range: "2026-10-01,2026-10-14" };
const row = (dimensions, metrics) => ({ dimensions, metrics });
const dates = days.map((_, i) => "2026-10-" + String(i + 1).padStart(2, "0"));
const pages = ["/", "/docs", "/pricing", "/blog", "/changelog", "/guides"];
const standardCases = [
  [
    "Traffic",
    "get_timeseries",
    { ...period, metrics: ["visitors", "pageviews", "bounce_rate"] },
    days.map((v, i) => row([dates[i]], [v, v * 2 + 17, scores[i]])),
  ],
  [
    "Pages",
    "get_breakdown",
    { ...period, dimension: "event:page", metrics: ["visitors", "pageviews"], limit: 5 },
    pages.map((p, i) =>
      row([p], [[804, 618, 401, 275, 144, 79][i], [1620, 982, 721, 403, 240, 164][i]]),
    ),
  ],
  [
    "Conversions",
    "get_conversions",
    { ...period, breakdown_by_page: true },
    [
      row(["Signup", "/pricing"], [45, 52, 7.8]),
      row(["Signup", "/"], [31, 38, 3.9]),
      row(["Download", "/docs"], [22, 29, 3.6]),
    ],
  ],
  [
    "Compare periods",
    "compare_periods",
    {
      site_id: period.site_id,
      page: "/docs*", goal: "Signup", property_filters: [{property:"plan", values:["trial"]}],
      period_a: "2026-09-17,2026-09-30",
      period_b: period.date_range,
      metrics: ["visitors", "bounce_rate"],
    },
    (q) => [row([], q.date_range[0] === "2026-09-17" ? [2710, 48.5] : [3124, 43.2])],
  ],
  [
    "Feedback receipt",
    "send_feedback",
    { task: "Review the chart", kind: "idea", impact: "friction", description: "Show the date for each observation." },
    [],
  ],
];
const cases = [
  ...standardCases,
  [
    "Hourly traffic", "get_timeseries", { ...period, granularity: "hour", metrics: ["visitors"] },
    [[0, 0], [1, null], [2, 7], [8, 12]].map(([hour, value]) => row(["2026-10-01T0" + hour + ":00:00"], [value])),
  ],
  [
    "Weekly traffic", "get_timeseries",
    { ...period, date_range: "2026-10-01,2026-10-25", granularity: "week", metrics: ["visitors"] },
    ["2026-10-01", "2026-10-05", "2026-10-19"].map((date, i) => row([date], [i + 1])),
  ],
  [
    "Monthly traffic", "get_timeseries",
    { ...period, date_range: "2025-12-01,2026-03-31", granularity: "month", metrics: ["visitors"] },
    ["2025-12-01", "2026-01-01", "2026-03-01"].map((date, i) => row([date], [i + 1])),
  ],
  [
    "Empty baseline", "compare_periods",
    { site_id: period.site_id, period_a: "7d", period_b: "30d", metrics: ["visitors"] },
    (q) => q.date_range === "7d" ? [] : [row([], [24])],
  ],
];
for (const [, name, args] of standardCases) {
  if (name === "send_feedback") continue;
  cases.push(["Empty result", name, args, []], ["Query error", name, args, null]);
}
let fixture;
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), "https://fixture.invalid/api/v2/query");
  if (fixture === null)
    return Response.json({ error: "This fixture site is unavailable." }, { status: 400 });
  const q = JSON.parse(init.body);
  return Response.json({
    results: typeof fixture === "function" ? fixture(q) : fixture,
    query: q,
    meta: {},
  });
};
const server = createServer({
  apiKey: "fixture-only",
  baseUrl: "https://fixture.invalid",
  enableFeedbackTool: true,
});
const appClientOptions = {
  capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
};
const client = new Client({ name: "ui-review", version: "1" }, appClientOptions);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
try {
  const { tools } = await client.listTools();
  assert.deepEqual(new Set(tools.map((tool) => tool.name)), new Set(cases.map((c) => c[1])));
  assert.deepEqual(tools.find(tool => tool.name === "send_feedback")._meta.ui.visibility, ["model"]);
  const resources = await client.listResources();
  const uri = resources.resources[0]?.uri;
  assert.ok(uri?.startsWith("ui://"));
  for (const tool of tools) assert.equal(tool._meta.ui.resourceUri, uri);
  const {
    contents: [resource],
  } = await client.readResource({ uri });
  assert.equal(resource.mimeType, "text/html;profile=mcp-app");
  const stdio = new Client({ name: "stdio-ui-review", version: "1" }, appClientOptions);
  try {
    await stdio.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
        env: { PLAUSIBLE_API_KEY: "fixture-only", PLAUSIBLE_BASE_URL: "https://fixture.invalid" },
        stderr: "pipe",
      }),
    );
    const { tools: stdioTools } = await stdio.listTools();
    assert.equal(stdioTools.length, 4);
    assert.ok(
      stdioTools.every(
        (tool) => tool.name !== "send_feedback" && tool._meta.ui.resourceUri === uri,
      ),
    );
    assert.equal((await stdio.readResource({ uri })).contents[0].text, resource.text);
  } finally {
    await stdio.close();
  }
  const scenarios = [];
  for (const [label, name, args, rows] of cases) {
    fixture = rows;
    const result = await client.callTool({ name, arguments: args });
    assert.equal(Boolean(result.isError), label === "Query error", label);
    assert.ok(result.isError || result.structuredContent, label);
    assert.ok(result.content.some((block) => block.type === "text" && block.text.length), label);
    scenarios.push({ label, tool: tools.find((tool) => tool.name === name), args, result });
  }
  const feedback = scenarios.find((s) => s.tool.name === "send_feedback");
  scenarios.push({
    ...feedback,
    label: "Feedback error",
    result: { isError: true, content: [{ type: "text", text: "The feedback service could not save this report." }] },
  });
  const directory = new URL("../coverage/ui-review/", import.meta.url);
  const hostScript = await build({
    entryPoints: [fileURLToPath(new URL("ui-host.js", import.meta.url))],
    bundle: true,
    format: "iife",
    minify: true,
    write: false,
  });
  const template = await readFile(new URL("ui-host.html", import.meta.url), "utf8");
  const comparison = scenarios.find(s => s.label === "Compare periods").args;
  const dailyReadings = {};
  for (const range of [comparison.period_a, comparison.period_b]) {
    const start = Date.parse(range.split(",")[0]);
    fixture = [0, 2, 3, 4].map((day, i) => row([new Date(start + day * 86400000).toISOString().slice(0, 10)],
      range === comparison.period_a ? [[19, 40], [29, null], [0, 35], [44, 49]][i] : [[23, 44], [34, 39], [41, 37], [40, 42]][i]));
    const result = await client.callTool({name: "get_timeseries", arguments: {
      site_id: comparison.site_id, date_range: range, granularity: "day", metrics: comparison.metrics,
    }});
    assert.ok(!result.isError && result.structuredContent);
    dailyReadings[range] = result;
  }
  const fixtures = JSON.stringify({ html: resource.text, scenarios, dailyReadings }).replaceAll("<", "\\u003c");
  const document = template
    .replace("<!--fixtures-->", () => '<script type="application/json" id="fixtures">' + fixtures + "</script>")
    .replace("<!--bridge-->", () => "<script>" + hostScript.outputFiles[0].text + "</script>");
  await mkdir(directory, { recursive: true });
  await writeFile(new URL("index.html", directory), document);
  await writeFile(new URL("landing.html", directory), landingHtml);
  console.log(`Verified ${tools.length} tools and ${cases.length + Object.keys(dailyReadings).length} calls. Open coverage/ui-review/index.html or landing.html.`);
} finally {
  await client.close();
  await server.close();
}
