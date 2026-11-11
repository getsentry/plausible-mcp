import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const { html, scenarios } = JSON.parse(document.getElementById("fixtures").textContent);
const sample = document.getElementById("sample");
const theme = document.getElementById("theme");
const width = document.getElementById("width");
const main = document.querySelector("main");
const status = document.querySelector("output");
let bridge;

for (const { label } of scenarios) sample.add(new Option(label));
async function openSample() {
  if (bridge) await bridge.close();
  const { args, result, tool } = scenarios[sample.selectedIndex];
  const frame = document.createElement("iframe");
  frame.title = "Plausible Analytics";
  frame.sandbox = "allow-scripts";
  frame.setAttribute("csp", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'");
  main.replaceChildren(frame);
  status.textContent = "Connecting…";
  bridge = new AppBridge(null, { name: "Review host", version: "1" }, {}, {
    hostContext: { theme: theme.value, toolInfo: { tool } },
  });
  bridge.oninitialized = async () => {
    await bridge.sendToolInput({ arguments: args });
    await bridge.sendToolResult(result);
    status.textContent = "Connected to the review host";
  };
  bridge.onsizechange = ({ height }) => {
    if (Number.isFinite(height)) frame.style.height = height + "px";
  };
  await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
  frame.srcdoc = html;
}
sample.onchange = openSample;
theme.onchange = () => bridge.setHostContext({ theme: theme.value });
width.onchange = () => { main.style.maxWidth = width.value; };
openSample();
