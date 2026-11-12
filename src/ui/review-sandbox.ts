// A data URL gives this fixed demo proxy an opaque origin, including when the review page is opened from disk.
const proxyHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<style>html,body,iframe{width:100%;height:100%;margin:0;border:0;display:block}</style></head>
<body><script>
const resourceReady = "ui/notifications/sandbox-resource-ready";
let view;
addEventListener("message", event => {
  const message = event.data;
  if (message?.jsonrpc !== "2.0") return;
  if (event.source === parent && message.method === resourceReady && !view) {
    if (typeof message.params?.html !== "string") return;
    view = document.createElement("iframe");
    view.title = "Analytics result";
    view.sandbox = "allow-scripts";
    const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'";
    const template = new DOMParser().parseFromString(message.params.html, "text/html");
    const meta = template.createElement("meta");
    meta.httpEquiv = "Content-Security-Policy";
    meta.content = policy;
    template.head.prepend(meta);
    view.srcdoc = "<!doctype html>" + template.documentElement.outerHTML;
    document.body.append(view);
    return;
  }
  if (!view || message.method?.startsWith("ui/notifications/sandbox-")) return;
  if (event.source === parent) {
    const theme = message.result?.hostContext?.theme ?? (message.method === "ui/notifications/host-context-changed" ? message.params?.theme : undefined);
    if (theme === "light" || theme === "dark") document.documentElement.style.colorScheme = theme;
    view.contentWindow.postMessage(message, "*");
  }
  else if (event.source === view.contentWindow) parent.postMessage(message, "*");
});
parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/sandbox-proxy-ready",params:{}}, "*");
</script></body></html>`;

export const reviewSandboxUrl = "data:text/html;charset=utf-8," + encodeURIComponent(proxyHtml);
