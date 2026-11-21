import { analyticsStyles } from "./styles.js";
import { comparisonFollowup } from "./comparison-followup.js";
import { comparisonTrend } from "./comparison-trend.js";
import { viewFormatting } from "./view-format.js";
import { viewTables } from "./view-table.js";
import { viewTimeseries } from "./view-timeseries.js";

export const analyticsHtml = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Plausible Analytics</title>
<style>${analyticsStyles}</style></head><body style="margin:0">
<section id="plausible-app" aria-label="Plausible Analytics">
  <div class="identity"><span class="mark" aria-hidden="true"><i></i><i></i><i></i></span>Plausible Analytics</div>
  <div class="heading"><div><h2>Analytics</h2><p class="context"></p></div></div>
  <div class="controls" hidden>
    <span class="metric-picker"><select aria-label="Metric"></select></span>
    <div class="modes" aria-label="Result view" role="group"><button type="button" data-mode="chart">Chart</button><button type="button" data-mode="trend" hidden>Daily trend</button><button type="button" data-mode="data">Data</button></div>
  </div>
  <div class="result" aria-busy="true">Waiting for a tool result…</div>
</section>
<script>
(() => {
  const root = document.getElementById("plausible-app");
  let toolName;
  const find = (selector) => root.querySelector(selector);
  const output = find(".result"),
    controls = find(".controls"),
    select = find("select");
  let data,
    input = {},
    page = 0,
    mode = "chart",
    point = 0;
  ${viewFormatting}
  ${viewTables}
  ${viewTimeseries}
  function metricNames(result) {
    if (!result.period_a) return result.metrics;
    return [...new Set([...Object.keys(result.period_a.metrics), ...Object.keys(result.period_b.metrics)])];
  }
  ${comparisonFollowup}
  ${comparisonTrend}
  function comparison(key) {
    if (mode === "trend") { drawTrend(key); return; }
    const a = data.period_a,
      b = data.period_b;
    const pct = (k) =>
      data.deltas[k]?.percent == null ? "—" : format(data.deltas[k].percent, "percentage");
    if (mode === "data") {
      table(
        ["Metric", "Baseline · " + a.range, "Comparison · " + b.range, "Change", "Change %"],
        metricNames(data).map((k) => [
          nice(k),
          format(a.metrics[k], k),
          format(b.metrics[k], k),
          formatChange(data.deltas[k]?.absolute, k),
          pct(k),
        ]),
      );
    } else {
      const pair = node("div", undefined, "pair");
      for (const [label, p] of [
        ["Baseline", a],
        ["Comparison", b],
      ]) {
        const box = node("div");
        box.append(
          node("p", label, "detail"),
          node("div", format(p.metrics[key], key), "value"),
          node("p", rangeLabel(p.range), "detail"),
        );
        pair.append(box);
      }
      output.append(
        pair,
        node(
          "p",
          "Change: " +
            formatChange(data.deltas[key]?.absolute, key) +
            (pct(key) === "—" ? " · Relative change unavailable" : " (" + pct(key) + ")"),
          "detail",
        ),
      );
    }
  }
  function formatChange(value, key) {
    if (!number(value)) return "—";
    return (value > 0 ? "+" : "") + (rates.has(key) ? formatNumber.format(value) + " pp" : format(value, key));
  }
  function render() {
    if (!data) return;
    const focusedTrend = mode === "trend" && find(".trend-plot .plot:focus");
    const inspecting = focusedTrend && !find(".trend-tooltip").hidden;
    output.replaceChildren();
    const key = select.value;
    select.parentElement.style.visibility = mode === "data" ? "hidden" : "visible";
    for (const b of controls.querySelectorAll("button"))
      b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
    if (data.period_a) comparison(key);
    else if (mode === "data") renderRows();
    else if (data.dimensions[0]?.startsWith("time:")) timeseries(key);
    else rank(key);
    if (focusedTrend && find(".trend-tooltip")) {
      find(".trend-plot .plot").focus({preventScroll:true});
      find(".trend-tooltip").hidden = !inspecting;
    }
  }
  select.onchange = () => { clearSelection(); render(); };
  for (const b of controls.querySelectorAll("button"))
    b.onclick = () => {
      if (mode === "trend" && b.dataset.mode !== mode) clearSelection();
      mode = b.dataset.mode;
      if (mode === "trend" && !trend) loadTrend();
      else render();
    };
  function result(payload) {
    const d = payload?.structuredContent;
    if (payload?.isError) {
      showMessage(
        toolName === "send_feedback" ? "Feedback failed" : "Query failed",
        payload.content?.find((c) => c.type === "text")?.text ?? "The tool returned an error.",
      );
      return;
    }
    if (typeof d?.feedback_id === "string") {
      showMessage("Feedback received", "The maintainers can review your submission.");
      output.append(node("p", "Receipt ID", "detail"), node("code", d.feedback_id));
      return;
    }
    const compare = d?.period_a?.metrics && d?.period_b?.metrics && d?.deltas;
    if (
      !compare &&
      !(Array.isArray(d?.metrics) && Array.isArray(d.dimensions) && Array.isArray(d.results))
    ) {
      showMessage("Result unavailable", "This response has no supported analytics data.");
      return;
    }
    const dimension = d.dimensions?.[0];
    const conversions = toolName === "get_conversions" ||
      (!toolName && !input.dimension && dimension === "event:goal" && d.metrics.includes("conversion_rate"));
    let title;
    if (compare) title = "Period comparison";
    else if (dimension?.startsWith("time:")) title = "Traffic over time";
    else if (conversions) title = "Goal conversions";
    else if (dimension === "event:page") title = "Top pages";
    else title = "Breakdown by " + nice(dimension ?? "category").toLowerCase();
    const metrics = metricNames(d);
    if ((!compare && !d.results.length) || !metrics.length) {
      showMessage(title, "No results for this query.");
      return;
    }
    setTitle(title);
    clearSelection();
    data = d;
    trend = undefined;
    selectedDay = 0;
    const inputMatches = compare && (input.period_a ?? d.period_a.range) === d.period_a.range && input.period_b === d.period_b.range;
    find("[data-mode=trend]").hidden = !(inputMatches && canCallTools && dailyWindow(d.period_a.range) && dailyWindow(d.period_b.range));
    find("[data-mode=chart]").textContent = compare ? "Summary" : "Chart";
    mode = "chart";
    page = 0;
    point = (d.results?.length ?? 1) - 1;
    select.replaceChildren(
      ...metrics.map((k) => {
        const opt = node("option", nice(k));
        opt.value = k;
        return opt;
      }),
    );
    if (conversions) select.value = "conversion_rate";
    controls.hidden = false;
    output.setAttribute("aria-busy", "false");
    render();
  }
  const send = (message) => window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
  let ready = false,
    height = -1;
  function context(ctx) {
    if (ctx?.safeAreaInsets) {
      for (const edge of ["top", "right", "bottom", "left"]) {
        const pixels = ctx.safeAreaInsets[edge];
        if (Number.isFinite(pixels)) root.style.setProperty("--safe-" + edge, Math.max(0, pixels) + "px");
      }
    }
    if (ctx?.toolInfo) toolName = ctx.toolInfo.tool?.name;
    if (ctx?.containerDimensions) {
      const { width, maxWidth, height, maxHeight } = ctx.containerDimensions;
      root.style.width = Number.isFinite(width) ? "100%" : "";
      root.style.maxWidth = Number.isFinite(maxWidth) ? maxWidth + "px" : "";
      root.style.height = Number.isFinite(height) ? height + "px" : "";
      root.style.maxHeight = Number.isFinite(maxHeight) ? maxHeight + "px" : "";
    }
    if (ctx?.theme === "dark" || ctx?.theme === "light") {
      document.documentElement.dataset.theme = ctx.theme;
      document.documentElement.style.colorScheme = ctx.theme;
    }
    for (const [key, value] of Object.entries(ctx?.styles?.variables ?? {})) {
      if (
        /^--(?:color-(?:text|background|border|ring)-[a-z-]+|border-radius-(?:lg|sm)|font-(?:sans|text-(?:md|sm|xs)-size|heading-md-size))$/.test(key) &&
        typeof value === "string"
      )
        root.style.setProperty(key, value);
    }
  }
  function size() {
    const h = Math.ceil(root.getBoundingClientRect().height);
    if (ready && h !== height) {
      height = h;
      send({ method: "ui/notifications/size-changed", params: { height: h } });
    }
  }
  let lastWidth = -1;
  const observer = new ResizeObserver(() => {
    if (lastWidth !== root.clientWidth) {
      lastWidth = root.clientWidth;
      if (mode === "trend" || (mode === "chart" && data?.dimensions?.[0]?.startsWith("time:"))) render();
    }
    size();
  });
  observer.observe(root);
  function receive(e) {
    const m = e.data;
    if (e.source !== window.parent || !m || m.jsonrpc !== "2.0") return;
    if (!m.method && requests.has(m.id)) {
      const finish = requests.get(m.id);
      requests.delete(m.id);
      finish(m);
      return;
    }
    if (!ready && m.id === "init" && !m.method) {
      if (m.result?.protocolVersion !== "2026-01-26") {
        showMessage("Connection unavailable", "The host could not open this result.");
        return;
      }
      ready = true;
      hostCapabilities = m.result.hostCapabilities ?? {};
      canCallTools = Boolean(hostCapabilities.serverTools);
      context(m.result.hostContext);
      send({ method: "ui/notifications/initialized" });
      size();
      return;
    }
    if (!ready) return;
    switch (m.method) {
      case "ui/notifications/tool-input":
        pending(m.params?.arguments);
        break;
      case "ui/notifications/tool-result":
        result(m.params);
        break;
      case "ui/notifications/tool-cancelled":
        cancelled();
        break;
      case "ui/notifications/host-context-changed":
        context(m.params);
        break;
      case "ui/resource-teardown":
        data = undefined;
        for (const finish of requests.values()) finish({error: true});
        requests.clear();
        ready = false;
        observer.disconnect();
        document.removeEventListener("keydown", dismissTrendOnEscape);
        window.removeEventListener("message", receive);
        send({ id: m.id, result: {} });
        break;
      case "ping":
        send({ id: m.id, result: {} });
        break;
      default:
        if (m.method && m.id != null)
          send({ id: m.id, error: { code: -32601, message: "Method not found" } });
    }
  }
  if (window.parent !== window) {
    window.addEventListener("message", receive);
    send({
      id: "init",
      method: "ui/initialize",
      params: {
        protocolVersion: "2026-01-26",
        appInfo: { name: "Plausible Analytics", version: "1" },
        appCapabilities: {},
      },
    });
  }
})();
</script></body></html>`;
