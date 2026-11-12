import { analyticsHtml } from "./ui/view.js";

export const landingSecurityPolicy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const repo = "https://github.com/getsentry/plausible-mcp";
const endpoint = "https://plausible-mcp.sentry.dev/mcp";
const demo = {
  metrics: ["visitors", "pageviews"],
  dimensions: ["time:day"],
  results: [[284, 431], [318, 507], [296, 476], [405, 648], [379, 581], [458, 722], [512, 803]]
    .map((metrics, index) => ({ dimensions: ["2026-10-0" + (index + 1)], metrics })),
};
const commands = {
  Codex: 'codex mcp add plausible --url ' + endpoint + ' --bearer-token-env-var PLAUSIBLE_API_KEY',
  "Claude Code": 'claude mcp add --transport http plausible ' + endpoint + ' --header "Authorization: Bearer ${PLAUSIBLE_API_KEY}"',
  Cursor: JSON.stringify({ mcpServers: { plausible: { url: endpoint, headers: { Authorization: "Bearer YOUR_PLAUSIBLE_API_KEY" } } } }, null, 2),
};
const scriptValue = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");
const css = `
:root{color-scheme:light dark;--bg:light-dark(#f8f7f3,#19191c);--ink:light-dark(#22222a,#eeedf2);--soft:light-dark(#595963,#b6b4c1);--line:light-dark(#d7d5cc,#48464f);--sheet:light-dark(#fff,#222228);--accent:light-dark(#544ac0,#b7adff);font:16px/1.55 system-ui,sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink)}a{color:inherit;text-underline-offset:4px}
.wrap{width:min(1120px,calc(100% - 56px));margin:auto}header,footer{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:22px 0;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;font-weight:650;text-decoration:none}.mark{display:inline-flex;align-items:end;gap:3px;height:18px}.mark i{width:5px;background:var(--accent);height:7px;border-radius:3px}.mark i:nth-child(2){height:12px}.mark i:last-child{height:18px}
main{padding-block:clamp(40px,7vw,94px) 48px}.hero{display:grid;grid-template-columns:minmax(0,.88fr) minmax(0,1.12fr);align-items:center;gap:clamp(28px,5vw,72px)}
h1,h2,p{margin:0}h1{font:normal clamp(47px,5.6vw,80px)/.99 Georgia,serif;letter-spacing:-.055em;text-wrap:balance}h1 em{color:var(--accent);font-weight:normal}
.intro{font-size:clamp(16px,1.6vw,20px);color:var(--soft);margin:22px 0 24px;max-width:38ch}
.cta,button{font:inherit;border-radius:7px;cursor:pointer}.cta{display:inline-block;text-decoration:none;background:var(--ink);color:var(--bg);padding:10px 18px;font-weight:600}
figure{margin:0;min-width:0}figcaption{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px;color:var(--soft);font-size:13px}figcaption strong{color:var(--ink);font-weight:600}
.frame{overflow:hidden;border-radius:12px;background:var(--sheet);border:1px solid var(--line)}iframe{width:100%;height:380px;border:0;display:block}
.install{display:grid;grid-template-columns:minmax(200px,.8fr) minmax(0,1.2fr);gap:36px;margin-top:clamp(42px,7vw,80px);padding:36px 0;border-block:1px solid var(--line);align-items:start}
h2{font:normal clamp(30px,3vw,44px)/1.1 Georgia,serif;letter-spacing:-.04em}.install p,.trust p,footer{color:var(--soft)}.install p{margin-top:10px}
.tabs{display:flex;gap:4px;flex-wrap:wrap}.tabs button,.copy{background:transparent;color:var(--soft);padding:7px 10px;border:1px solid transparent;font-size:14px}.tabs button[aria-pressed=true]{background:var(--sheet);border-color:var(--line);color:var(--ink)}
.command{position:relative;margin-top:10px;border:1px solid var(--line);border-radius:8px;background:var(--sheet);padding:15px}.command pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:13px/1.6 ui-monospace,monospace}.copy{display:block;padding:5px 0;color:var(--accent);margin-top:6px}
.trust{padding-top:28px;max-width:72ch}.trust h2{font:600 16px system-ui,sans-serif;letter-spacing:0;margin-bottom:8px}.trust a,footer a{color:var(--ink)}footer{border-top:1px solid var(--line);border-bottom:0;font-size:13px}
:focus-visible{outline:3px solid var(--accent);outline-offset:3px}@media(max-width:760px){.wrap{width:calc(100% - 36px)}.hero,.install{grid-template-columns:minmax(0,1fr)}.hero{gap:32px}.install{gap:20px}header,footer{flex-wrap:wrap}}
`;
export const landingHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="Connect Plausible Analytics to your MCP client to explore traffic, pages and conversions in conversation.">
<title>Plausible MCP · Analytics in your chat</title><style>${css}</style></head><body>
<div class="wrap"><header><a class="brand" href="#top"><span class="mark" aria-hidden="true"><i></i><i></i><i></i></span>Plausible MCP</a><a href="${repo}">GitHub ↗</a></header>
<main id="top"><div class="hero"><div><h1>Your analytics,<br><em>in your chat.</em></h1><p class="intro">Ask what brought visitors to your site, which pages they read, and how this week compares. Explore the answer in your MCP client.</p><a class="cta" href="#install">Connect Plausible ↓</a></div>
<figure><figcaption><strong>Try the traffic chart</strong><span>Example data</span></figcaption><div class="frame"><iframe title="Interactive Plausible traffic chart" sandbox="allow-scripts"></iframe></div></figure></div>
<section class="install" id="install"><div><h2>Connect your client.</h2><p>You’ll need a <a href="https://plausible.io/docs/stats-api">Plausible Stats API key</a>.</p></div><div>
<div class="tabs" role="group" aria-label="Client">${Object.keys(commands).map((name,i) => `<button type="button" aria-pressed="${i===0}">${name}</button>`).join("")}</div>
<p id="setup">Set PLAUSIBLE_API_KEY in the environment where you start Codex, then run this command.</p>
<div class="command"><pre><code>${commands.Codex}</code></pre><button type="button" class="copy" aria-live="polite">Copy command</button></div><p><a href="${repo}#local-stdio">Local installation</a> · <a href="${repo}#quick-start">Other clients</a></p></div></section>
<section class="trust"><h2>What the connector can read</h2><p>The hosted endpoint uses your Stats API key to read the sites it covers. Site IDs and query results are excluded from its public endpoint telemetry. See <a href="${repo}/blob/main/TELEMETRY.md">telemetry details</a> or <a href="${repo}#self-hosting-cloudflare-workers">self-host the Worker</a>.</p></section></main>
<footer><span>A Sentry Developer Experience project. Community supported.</span><a href="${repo}/issues">Report an issue</a></footer></div>
<script>
const commands = ${scriptValue(commands)};
const setup = {"Codex":"Set PLAUSIBLE_API_KEY in the environment where you start Codex, then run this command.","Claude Code":"Set PLAUSIBLE_API_KEY in your shell, then run this command.","Cursor":"Add this entry to your MCP configuration and replace YOUR_PLAUSIBLE_API_KEY with your key."};
const copy = document.querySelector(".copy");
let client = "Codex";
function copyLabel(){return client === "Cursor" ? "Copy configuration" : "Copy command";}
const buttons = document.querySelectorAll(".tabs button");
for (const button of buttons) button.onclick = () => {
  client = button.textContent;
  for (const item of buttons) item.setAttribute("aria-pressed", String(item === button));
  document.querySelector("code").textContent = commands[client];
  document.querySelector("#setup").textContent = setup[client]; copy.textContent = copyLabel();
};
copy.onclick = async () => {
  try { await navigator.clipboard.writeText(commands[client]); copy.textContent = "Copied"; }
  catch { const range = document.createRange(); range.selectNodeContents(document.querySelector("pre")); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); copy.textContent = "Selected for copying"; }
};
const frame = document.querySelector("iframe");
const scheme = matchMedia("(prefers-color-scheme: dark)");
const context = () => ({theme:scheme.matches?"dark":"light",toolInfo:{tool:{name:"get_timeseries"}}});
const send = message => frame.contentWindow.postMessage({jsonrpc:"2.0",...message},"*");
addEventListener("message", event => {
  if (event.source !== frame.contentWindow || event.data?.jsonrpc !== "2.0") return;
  const {method,id,params} = event.data;
  if (method === "ui/initialize") send({id,result:{protocolVersion:"2026-01-26",hostInfo:{name:"Plausible MCP demo",version:"1"},hostCapabilities:{},hostContext:context()}});
  if (method === "ui/notifications/initialized") {
    send({method:"ui/notifications/tool-input",params:{arguments:{site_id:"example.com",date_range:"2026-10-01,2026-10-07"}}});
    send({method:"ui/notifications/tool-result",params:{content:[],structuredContent:${scriptValue(demo)}}});
  }
  if(method === "ui/notifications/size-changed" && Number.isFinite(params?.height)) frame.style.height = Math.min(1200,Math.max(100,params.height)) + "px";
});
scheme.addEventListener("change",()=>send({method:"ui/notifications/host-context-changed",params:context()}));
frame.srcdoc = ${scriptValue(analyticsHtml)};
</script></body></html>`;
