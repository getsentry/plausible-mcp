import { sandboxProxyUrl } from "../dist/ui/review-sandbox.js";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const { html, scenarios, dailyReadings } = JSON.parse(
  document.getElementById("fixtures").textContent,
);
const tool = document.getElementById("tool");
const sample = document.getElementById("sample");
const theme = document.getElementById("theme");
const width = document.getElementById("width");
const main = document.querySelector("main");
let bridge;
const params = new URLSearchParams(location.search);
const hostVariables = {
  "--color-background-primary": "light-dark(#ffffff, #262626)",
  "--color-text-primary": "light-dark(#1a1a1a, #f2f2f2)",
  "--color-text-secondary": "light-dark(#5c5c5c, #b3b3b3)",
  "--color-border-tertiary": "light-dark(#e0e0e0, #404040)",
  "--font-sans": "system-ui, sans-serif",
};
for (const [name, value] of Object.entries(hostVariables))
  document.documentElement.style.setProperty(name, value);
theme.value = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
document.documentElement.dataset.theme = theme.value;

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
  sample.replaceChildren(
    ...choices.map((s, i) => new Option(i === 0 ? "Result" : s.label, s.label)),
  );
  sample.add(new Option("Loading", "loading"));
  sample.add(new Option("Cancelled", "cancelled"));
  void openSample();
}
/** What this preview host offers the app: tool calls, and chat unless a URL flag removes it. */
function hostCapabilities() {
  if (params.has("display-only")) return {};
  const chat = { message: { text: {} }, updateModelContext: { structuredContent: {} } };
  return params.has("no-chat") ? { serverTools: {} } : { serverTools: {}, ...chat };
}

function answerDailyReads(active) {
  active.oncalltool = ({ name, arguments: args }) => {
    const reading = dailyReadings[args?.date_range];
    if (
      name !== "get_timeseries" ||
      !reading ||
      JSON.stringify(args) !== JSON.stringify(reading.args)
    )
      throw Error("No matching daily sample");
    return reading.result;
  };
}

/** Show what the app puts into the model context and the messages it sends to chat. */
function wireChat(active, capabilities, scenario) {
  const selection = document.getElementById("selection"),
    message = document.getElementById("message");
  selection.value = message.value = "";
  document.getElementById("chat").hidden =
    !capabilities.message || scenario.tool.name !== "compare_periods";
  if (!capabilities.message) return;
  active.onupdatemodelcontext = ({ structuredContent }) => {
    selection.value = JSON.stringify(structuredContent);
    return Promise.resolve({});
  };
  active.onmessage = ({ content }) => {
    if (params.has("decline")) return Promise.resolve({ isError: true });
    message.value = content[0].text;
    return Promise.resolve({});
  };
}

async function tearDown(previous) {
  try {
    if (previous.getAppCapabilities()) await previous.teardownResource({}, { timeout: 1000 });
  } catch (error) {
    // An error, not a warning, so the browser checks fail when teardown breaks.
    console.error("The previous app could not acknowledge teardown.", error);
  } finally {
    await previous.close();
  }
}

/** Once the app initializes, send it the tool input and then the selected lifecycle state. */
async function sendScenario(active, scenario, state) {
  if (!params.has("no-input")) await active.sendToolInput({ arguments: scenario.args });
  if (bridge !== active || state === "loading") return;
  if (state === "cancelled") await active.sendToolCancelled({ reason: "Cancelled in preview" });
  else await active.sendToolResult(scenario.result);
}

async function openSample() {
  const previous = bridge;
  const choices = scenarios.filter((s) => s.tool.name === tool.value);
  const state = sample.value;
  const scenario = choices.find((s) => s.label === state) ?? choices[0];
  const frame = document.createElement("iframe");
  frame.title = "Plausible Analytics";
  frame.sandbox = "allow-scripts allow-same-origin";
  const capabilities = hostCapabilities();
  const styles = params.has("no-host-styles") ? {} : { styles: { variables: hostVariables } };
  const active = new AppBridge(null, { name: "Review host", version: "1" }, capabilities, {
    hostContext: { theme: theme.value, toolInfo: { tool: scenario.tool }, ...styles },
  });
  active.onsandboxready = () => void active.sendSandboxResourceReady({ html });
  answerDailyReads(active);
  wireChat(active, capabilities, scenario);
  bridge = active;
  if (previous) await tearDown(previous);
  if (bridge !== active) return;
  main.replaceChildren(frame);
  active.oninitialized = () => void sendScenario(active, scenario, state);
  active.onsizechange = ({ height }) => {
    if (Number.isFinite(height)) frame.style.height = height + "px";
  };
  await active.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
  if (bridge === active) frame.src = sandboxProxyUrl(!params.has("plain-proxy"));
}
tool.onchange = selectTool;
sample.onchange = () => void openSample();
theme.onchange = () => {
  document.documentElement.dataset.theme = theme.value;
  if (bridge?.getAppCapabilities()) bridge.setHostContext({ theme: theme.value });
};
width.onchange = () => {
  main.style.maxWidth = width.value;
};
selectTool();
