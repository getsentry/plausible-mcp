import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const { html, scenarios, dailyReadings, reviewSandboxUrl } = JSON.parse(document.getElementById("fixtures").textContent);
const tool = document.getElementById("tool");
const sample = document.getElementById("sample");
const theme = document.getElementById("theme");
const width = document.getElementById("width");
const main = document.querySelector("main");
let bridge;

const names = {
  get_timeseries: "Traffic",
  get_breakdown: "Top pages",
  get_conversions: "Conversions",
  compare_periods: "Compare periods",
  send_feedback: "Feedback",
};
for (const name of new Set(scenarios.map((s) => s.tool.name))) {
  tool.add(new Option(names[name], name));
}

function selectTool() {
  const choices = scenarios.filter((s) => s.tool.name === tool.value);
  sample.replaceChildren(...choices.map((s, i) => new Option(i === 0 ? "Result" : s.label, s.label)));
  sample.add(new Option("Loading", "loading"));
  sample.add(new Option("Cancelled", "cancelled"));
  openSample();
}
async function openSample() {
  const previous = bridge;
  const choices = scenarios.filter((s) => s.tool.name === tool.value);
  const state = sample.value;
  const scenario = choices.find((s) => s.label === state) ?? choices[0];
  const frame = document.createElement("iframe");
  frame.title = "Plausible Analytics";
  frame.sandbox = "allow-scripts allow-same-origin";
  const capabilities = new URLSearchParams(location.search).has("display-only") ? {} : {serverTools: {}};
  const active = new AppBridge(null, { name: "Review host", version: "1" }, capabilities, {
    hostContext: { theme: theme.value, toolInfo: { tool: scenario.tool } },
  });
  active.onsandboxready = () => active.sendSandboxResourceReady({html});
  active.oncalltool = ({ name, arguments: args }) => {
    if (name !== "get_timeseries" || !dailyReadings[args.date_range]) throw Error("No matching daily sample");
    return dailyReadings[args.date_range];
  };
  bridge = active;
  if (previous) {
    try {
      if (previous.getAppCapabilities()) await previous.teardownResource({}, {timeout: 1000});
    } catch (error) {
      console.warn("The previous app could not acknowledge teardown.", error);
    } finally {
      await previous.close();
    }
  }
  if (bridge !== active) return;
  main.replaceChildren(frame);
  active.oninitialized = async () => {
    await active.sendToolInput({ arguments: scenario.args });
    if (bridge !== active || state === "loading") return;
    if (state === "cancelled") await active.sendToolCancelled({ reason: "Cancelled in preview" });
    else await active.sendToolResult(scenario.result);
  };
  active.onsizechange = ({ height }) => {
    if (Number.isFinite(height)) frame.style.height = height + "px";
  };
  await active.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
  if (bridge === active) frame.src = reviewSandboxUrl;
}
tool.onchange = selectTool;
sample.onchange = openSample;
theme.onchange = () => {
  if (bridge?.getAppCapabilities()) bridge.setHostContext({ theme: theme.value });
};
width.onchange = () => { main.style.maxWidth = width.value; };
selectTool();
