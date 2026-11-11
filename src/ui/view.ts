export const analyticsHtml = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Plausible Analytics</title>
<style>
#plausible-app {
  color-scheme: light dark;
  --ink: var(--color-text-primary, light-dark(#1d2534,#eef1f7));
  --sub: var(--color-text-secondary, light-dark(#566278,#b2bdd0));
  --line: var(--color-border-tertiary, light-dark(#dce2ed,#394457));
  --paper: var(--color-background-primary, light-dark(#ffffff,#161c27));
  --soft: var(--color-background-secondary, light-dark(#f3f5fa,#222b39));
  --accent: light-dark(#4a54c8,#a6acff);
  box-sizing:border-box; overflow:auto; max-width:100%; background:var(--paper); color:var(--ink);
  padding:clamp(14px,2.5vw,22px); border-radius:12px;
  font:14px/1.45 var(--font-sans,system-ui,sans-serif); font-variant-numeric:tabular-nums;
}
#plausible-app * {box-sizing:border-box}
#plausible-app [hidden] {display:none!important}
#plausible-app :is(h2,p) {margin:0}
#plausible-app .identity {display:flex;gap:8px;align-items:center;color:var(--sub);font-weight:600;font-size:12px}
#plausible-app .mark {display:inline-flex;gap:2px;align-items:flex-end;height:15px}
#plausible-app .mark i {width:4px;background:var(--accent);border-radius:2px}
#plausible-app .mark i:nth-child(1){height:7px} #plausible-app .mark i:nth-child(2){height:11px} #plausible-app .mark i:nth-child(3){height:15px}
#plausible-app .heading,#plausible-app .controls,#plausible-app .pager {display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}
#plausible-app .heading {margin:6px 0 12px}
#plausible-app h2 {font-size:clamp(20px,3vw,25px);letter-spacing:-.025em;line-height:1.15}
#plausible-app .context,#plausible-app .detail {color:var(--sub);overflow-wrap:anywhere}
#plausible-app .context {font-size:13px;margin-top:5px}
#plausible-app .controls {padding:0 0 12px}
#plausible-app .result {display:flow-root}
#plausible-app :is(select,button) {font:inherit;color:var(--ink);font-size:13px;border:1px solid var(--line);border-radius:6px;background:var(--paper);padding:5px 9px;cursor:pointer}
#plausible-app .metric-picker {position:relative;display:inline-grid;max-width:100%}
#plausible-app .metric-picker select {appearance:none;width:100%;padding-inline:10px 32px}
#plausible-app .metric-picker::after {content:"";position:absolute;inset-inline-end:12px;top:50%;width:6px;height:6px;border:solid currentColor;border-width:0 1.5px 1.5px 0;transform:translateY(-70%) rotate(45deg);pointer-events:none}
@media(forced-colors:active){#plausible-app .metric-picker select {appearance:auto;padding-inline-end:8px} #plausible-app .metric-picker::after {display:none}}
@media(pointer:coarse){#plausible-app :is(select,button) {min-height:44px} #plausible-app .metric-picker select {font-size:16px}}
#plausible-app button:enabled:hover {background:var(--soft)}
#plausible-app button:disabled {opacity:.45;cursor:default}
#plausible-app :focus-visible {outline:2px solid var(--accent);outline-offset:2px}
#plausible-app .modes {display:flex;gap:2px;padding:2px;background:var(--soft);border-radius:7px}
#plausible-app .modes button {border:0;background:transparent;color:var(--sub)}
#plausible-app .modes button[aria-pressed=true] {background:var(--paper);color:var(--ink);box-shadow:0 1px 3px #0002}
#plausible-app .value {font-size:clamp(26px,5vw,38px);font-weight:650;letter-spacing:-.055em;line-height:1.25}
#plausible-app .detail {font-size:12px}
#plausible-app .plot {display:block;width:100%;height:176px;touch-action:pan-y;color:var(--sub);overflow:visible}
#plausible-app .plot text {font:11px system-ui,sans-serif;fill:currentColor}
#plausible-app .ranking {display:grid;grid-template-columns:minmax(0,1fr) max-content;gap:3px 12px;margin:0;padding:0;list-style:none}
#plausible-app .rank {display:grid;grid-column:1/-1;grid-template-columns:subgrid;align-items:center;min-height:30px}
#plausible-app .rank strong {text-align:end;font-weight:550}
#plausible-app .rank-label {position:relative;isolation:isolate;overflow-wrap:anywhere;padding:5px 9px}
#plausible-app .rank-label::before {content:"";position:absolute;z-index:-1;inset-block:0;inset-inline-start:0;width:var(--share);border-radius:3px;background:color-mix(in srgb,var(--accent) 17%,transparent)}
#plausible-app .table-wrap {overflow-x:auto}
#plausible-app table {border-collapse:collapse;width:100%} #plausible-app :is(th,td) {padding:8px 9px;text-align:right;border-bottom:1px solid var(--line);font-size:13px;white-space:nowrap}
#plausible-app th {font-weight:550;color:var(--sub)}
#plausible-app :is(th,td):first-child {text-align:left;white-space:normal;overflow-wrap:anywhere}
#plausible-app .pair {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:12px 0}
#plausible-app .pair>div {border-left:2px solid var(--line);padding-left:10px;overflow-wrap:anywhere}
#plausible-app .pair>div:last-child {border-color:var(--accent)}
#plausible-app .pager {margin:10px 0} #plausible-app .pager div {display:flex;gap:5px}
#plausible-app .note {margin-top:12px;color:var(--sub);font-size:13px}
#plausible-app .state-message {padding-block:12px;color:var(--sub)}
#plausible-app code {overflow-wrap:anywhere}
</style></head><body style="margin:0">
<section id="plausible-app" aria-label="Plausible Analytics">
  <div class="identity"><span class="mark" aria-hidden="true"><i></i><i></i><i></i></span>Plausible Analytics</div>
  <div class="heading"><div><h2>Analytics</h2><p class="context"></p></div></div>
  <div class="controls" hidden>
    <span class="metric-picker"><select aria-label="Metric"></select></span>
    <div class="modes" aria-label="Result view" role="group"><button type="button" data-mode="chart">Chart</button><button type="button" data-mode="data">Data</button></div>
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
  const pageSize = 12;
  const nice = (s) =>
    String(s)
      .replace(/^(visit|event|time):/, "")
      .replaceAll("_", " ")
      .replace(/^./, (c) => c.toUpperCase());
  const readable = (value) => (value == null ? "—" : String(value));
  const number = (value) => typeof value === "number" && Number.isFinite(value);
  const formatNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const rates = new Set(["bounce_rate", "conversion_rate", "group_conversion_rate", "percentage", "scroll_depth"]);
  const durations = new Set(["visit_duration", "time_on_page"]);
  function format(value, key) {
    if (!number(value)) return readable(value);
    if (rates.has(key))
      return formatNumber.format(value) + "%";
    if (durations.has(key)) {
      const secs = Math.round(Math.abs(value));
      return (
        (value < 0 ? "−" : "") +
        (secs >= 60 ? Math.floor(secs / 60) + "m " : "") +
        (secs % 60) +
        "s"
      );
    }
    return formatNumber.format(value);
  }
  function node(tag, text, cls) {
    const elem = document.createElement(tag);
    if (text !== undefined) elem.textContent = text;
    if (cls) elem.className = cls;
    return elem;
  }
  function elSvg(tag, attrs, text) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, val] of Object.entries(attrs)) el.setAttribute(name, String(val));
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function rangeLabel(range) {
    if (typeof range !== "string") return "";
    const dates = range.split(",");
    if (dates.length === 2 && dates.every((d) => /^\d{4}-\d\d-\d\d$/.test(d))) {
      const formatter = new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });
      const [start, end] = dates.map((d) => new Date(d + "T00:00:00Z"));
      if (Number.isFinite(+start) && Number.isFinite(+end) && start <= end)
        return formatter.formatRange(start, end);
    }
    const days = /^(\d+)d$/.exec(range);
    return days ? "Last " + days[1] + (days[1] === "1" ? " day" : " days") : range;
  }
  function setTitle(title) {
    find("h2").textContent = title;
    find(".context").textContent = [
      input.site_id,
      rangeLabel(input.date_range),
      input.page,
      input.goal,
    ]
      .filter((x) => typeof x === "string" && x.length)
      .join(" · ");
  }
  function showMessage(title, message, busy = false) {
    data = undefined;
    setTitle(title);
    controls.hidden = true;
    output.setAttribute("aria-busy", String(busy));
    output.replaceChildren(node("p", message, "state-message"));
  }
  function pending(args) {
    input = args ?? {};
    const titles = {
      get_timeseries: "Traffic over time",
      get_breakdown: input.dimension === "event:page" ? "Top pages" : "Breakdown",
      get_conversions: "Goal conversions",
      compare_periods: "Period comparison",
      send_feedback: "Feedback",
    };
    showMessage(titles[toolName] ?? "Analytics",
      toolName === "send_feedback" ? "Sending feedback…" : "Loading results…", true);
  }
  function cancelled() {
    showMessage(toolName === "send_feedback" ? "Feedback cancelled" : "Query cancelled",
      "The tool stopped before a result arrived.");
  }
  function dimensionLabel(value, key) {
    if (value === "" && ["visit:entry_page", "visit:exit_page"].includes(key))
      return "No pageview recorded";
    if (value === "") return "(empty)";
    if (!key?.startsWith("time:")) return readable(value);
    const match = /^(\d{4}-\d\d-\d\d)(?:[ T](\d\d:\d\d))?/.exec(String(value));
    if (!match) return readable(value);
    const date = new Date(match[1] + "T00:00:00Z");
    if (isNaN(date)) return readable(value);
    return (
      date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }) +
      (match[2] ? " · " + match[2] : "")
    );
  }
  function rowLabel(row) {
    return row.dimensions.map((value, i) => dimensionLabel(value, data.dimensions[i])).join(" · ");
  }
  function table(headers, rows) {
    const wrap = node("div", undefined, "table-wrap"),
      tbl = node("table"),
      header = tbl.createTHead().insertRow();
    for (const label of headers) {
      const th = node("th", label);
      th.scope = "col";
      header.append(th);
    }
    const body = tbl.createTBody();
    for (const row of rows) {
      const tr = body.insertRow();
      for (const value of row) tr.append(node("td", value));
    }
    wrap.append(tbl);
    output.append(wrap);
  }
  function renderRows() {
    const rows = data.results,
      offset = data.pagination?.offset ?? 0;
    const batch = rows.slice(page * pageSize, (page + 1) * pageSize);
    table(
      [...data.dimensions.map(nice), ...data.metrics.map(nice)],
      batch.map((r) => [
        ...data.dimensions.map((key, i) =>
          key.startsWith("time:")
            ? readable(r.dimensions[i])
            : dimensionLabel(r.dimensions[i], key),
        ),
        ...data.metrics.map((key, i) => format(r.metrics[i], key)),
      ]),
    );
    const footer = node("div", undefined, "pager");
    footer.append(
      node(
        "span",
        "Rows " + (offset + page * pageSize + 1) + "–" + (offset + page * pageSize + batch.length),
        "detail",
      ),
    );
    if (rows.length > pageSize) {
      const buttons = node("div");
      for (const [label, step] of [
        ["Previous", -1],
        ["Next", 1],
      ]) {
        const b = node("button", label);
        b.type = "button";
        b.disabled = page + step < 0 || (page + step) * pageSize >= rows.length;
        b.onclick = () => {
          page += step;
          render();
          const next = [...output.querySelectorAll(".pager button")];
          (
            next.find((x) => x.textContent === label && !x.disabled) ??
            next.find((x) => !x.disabled)
          )?.focus();
        };
        buttons.append(b);
      }
      footer.append(buttons);
    }
    output.append(footer);
    if (data.pagination?.has_more)
      output.append(
        node(
          "p",
          "More rows are available from Plausible at offset " + (offset + rows.length) + ".",
          "note",
        ),
      );
  }
  function rank(key) {
    const rows = data.results.slice(0, 10);
    const max = Math.max(
      0,
      ...rows.map((r) => (number(r.metrics[select.selectedIndex]) ? r.metrics[select.selectedIndex] : 0)),
    );
    const list = node("ol", undefined, "ranking");
    for (const row of rows) {
      const item = node("li", undefined, "rank"),
        value = row.metrics[select.selectedIndex];
      const label = node("span", rowLabel(row), "rank-label");
      const share = max && number(value) ? Math.max(0, value) / max : 0;
      label.style.setProperty("--share", share * 100 + "%");
      item.append(label, node("strong", format(value, key)));
      list.append(item);
    }
    output.append(list);
    if (data.results.length > rows.length)
      output.append(
        node(
          "p",
          rows.length + " of " + data.results.length + " rows",
          "note",
        ),
      );
  }
  function timeBucket(label, dimension) {
    // Plausible reports wall-clock labels in the site's timezone.
    const text = String(label);
    const date = new Date(text.slice(0, 10) + "T00:00:00Z");
    const day = date.getTime() / 86_400_000;
    if (dimension === "time:month") return date.getUTCFullYear() * 12 + date.getUTCMonth();
    // The Unix epoch was a Thursday. Plausible weeks start on Monday.
    if (dimension === "time:week") return Math.floor((day + 3) / 7);
    if (dimension === "time:hour") return day * 24 + Number(text.slice(11, 13));
    return day;
  }
  function timeseries(key) {
    const rows = data.results,
      values = rows.map((r) => r.metrics[select.selectedIndex]);
    const valid = values.filter(number);
    if (!valid.length) {
      output.append(
        node(
          "p",
          "No numeric observations for this metric. Open Data for the returned values.",
          "detail",
        ),
      );
      return;
    }
    const buckets = rows.map((row) => timeBucket(row.dimensions[0], data.dimensions[0]));
    if (buckets.some((bucket, i) => !number(bucket) || (i > 0 && bucket <= buckets[i - 1]))) {
      output.append(node("p", "Open Data to inspect the returned time labels.", "detail"));
      return;
    }
    const headline = node("div", undefined, "value"),
      detail = node("p", undefined, "detail");
    const svg = elSvg("svg", {
      class: "plot",
      height: 176,
      role: "group",
      tabindex: 0,
      "aria-label": nice(key) + ". Use left and right arrows to inspect observations.",
    });
    output.append(headline, detail, svg);
    const w = Math.max(180, Math.floor(svg.getBoundingClientRect().width)),
      top = 13,
      bottom = 143;
    const lo = Math.min(0, ...valid);
    let hi = Math.max(0, ...valid);
    if (hi === lo) hi = 1;
    const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
    const axisFormat = (v) => rates.has(key) || durations.has(key) ? format(v, key) : compact.format(v);
    const left = Math.max(38, Math.max(axisFormat(lo).length, axisFormat(hi).length) * 7 + 10),
      right = w - 8;
    const span = buckets.at(-1) - buckets[0];
    const x = (i) => span === 0 ? (left + right) / 2 :
      left + ((buckets[i] - buckets[0]) / span) * (right - left);
    const y = (v) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
    svg.setAttribute("viewBox", "0 0 " + w + " 176");
    for (const tick of [hi, (hi + lo) / 2, lo]) {
      svg.append(
        elSvg("line", {
          x1: left,
          x2: right,
          y1: y(tick),
          y2: y(tick),
          stroke: "var(--line)",
          "stroke-dasharray": "3 4",
        }),
        elSvg("text", { x: left - 7, y: y(tick) + 4, "text-anchor": "end" }, axisFormat(tick)),
      );
    }
    let path = "",
      area = "",
      segment = "",
      segmentStart = 0;
    function closeSegment(end) {
      if (!segment) return;
      if (segmentStart === end)
        svg.append(elSvg("circle", { cx: x(end), cy: y(values[end]), r: 3, fill: "var(--accent)" }));
      path += segment;
      area +=
        segment + " L" + x(end) + "," + bottom + " L" + x(segmentStart) + "," + bottom + " Z ";
      segment = "";
    }
    values.forEach((v, i) => {
      if (!number(v) || buckets[i] - buckets[i - 1] > 1) closeSegment(i - 1);
      if (!number(v)) return;
      if (!segment) segmentStart = i;
      segment += (segment ? " L" : "M") + x(i) + "," + y(v);
    });
    closeSegment(values.length - 1);
    svg.append(
      elSvg("path", { d: area, fill: "var(--accent)", opacity: 0.09 }),
      elSvg("path", {
        d: path,
        fill: "none",
        stroke: "var(--accent)",
        "stroke-width": 2.5,
        "stroke-linejoin": "round",
      }),
    );
    const ticks = rows.length === 1 ? [0] : [0, rows.length - 1];
    const mid = Math.floor(rows.length / 2);
    if (rows.length > 2 && w > 510 && x(mid) - left > 105 && right - x(mid) > 105) ticks.splice(1, 0, mid);
    for (const i of ticks)
      svg.append(
        elSvg(
          "text",
          {
            x: x(i),
            y: 168,
            "text-anchor":
              rows.length === 1
                ? "middle"
                : i === 0
                  ? "start"
                  : i === rows.length - 1
                    ? "end"
                    : "middle",
          },
          rowLabel(rows[i]),
        ),
      );
    const guide = elSvg("line", {
      y1: top,
      y2: bottom,
      stroke: "var(--accent)",
      opacity: 0.55,
      "stroke-dasharray": "3 3",
    });
    const dot = elSvg("circle", {
      r: 4.5,
      fill: "var(--accent)",
      stroke: "var(--paper)",
      "stroke-width": 2,
    });
    svg.append(guide, dot);
    function inspect(i) {
      point = Math.max(0, Math.min(rows.length - 1, i));
      const v = values[point];
      headline.textContent = format(v, key);
      detail.textContent = nice(key) + " · " + rowLabel(rows[point]);
      guide.setAttribute("x1", x(point));
      guide.setAttribute("x2", x(point));
      dot.style.display = number(v) ? "" : "none";
      if (number(v)) {
        dot.setAttribute("cx", x(point));
        dot.setAttribute("cy", y(v));
      }
      svg.setAttribute(
        "aria-label",
        detail.textContent +
          ", " +
          headline.textContent +
          ". Use left and right arrows to inspect observations.",
      );
    }
    function pointer(e) {
      const bounds = svg.getBoundingClientRect();
      const cursor = ((e.clientX - bounds.left) * w) / bounds.width;
      let first = 0, last = rows.length - 1;
      while (first < last) {
        const middle = Math.floor((first + last) / 2);
        if (cursor > (x(middle) + x(middle + 1)) / 2) first = middle + 1;
        else last = middle;
      }
      inspect(first);
    }
    svg.onpointermove = pointer;
    svg.onpointerdown = pointer;
    svg.onkeydown = (e) => {
      const index = { ArrowLeft: point - 1, ArrowRight: point + 1, Home: 0, End: rows.length - 1 }[
        e.key
      ];
      if (index !== undefined) {
        e.preventDefault();
        inspect(index);
      }
    };
    inspect(point);
  }
  function metricNames(result) {
    if (!result.period_a) return result.metrics;
    return [...new Set([...Object.keys(result.period_a.metrics), ...Object.keys(result.period_b.metrics)])];
  }
  function comparison(key) {
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
          delta(k),
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
            delta(key) +
            (pct(key) === "—" ? " · Relative change unavailable" : " (" + pct(key) + ")"),
          "detail",
        ),
      );
    }
    function delta(k) {
      const v = data.deltas[k]?.absolute;
      const rate = rates.has(k);
      return (
        (number(v) && v > 0 ? "+" : "") +
        (number(v) && rate ? formatNumber.format(v) + " pp" : format(v, k))
      );
    }
  }
  function render() {
    if (!data) return;
    output.replaceChildren();
    const key = select.value;
    select.parentElement.style.visibility = mode === "data" ? "hidden" : "visible";
    for (const b of controls.querySelectorAll("button"))
      b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
    if (data.period_a) comparison(key);
    else if (mode === "data") renderRows();
    else if (data.dimensions[0]?.startsWith("time:")) timeseries(key);
    else rank(key);
  }
  select.onchange = render;
  for (const b of controls.querySelectorAll("button"))
    b.onclick = () => {
      mode = b.dataset.mode;
      render();
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
    data = d;
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
    if (ctx?.toolInfo) toolName = ctx.toolInfo.tool?.name;
    if (ctx?.containerDimensions) {
      const { width, maxWidth, height, maxHeight } = ctx.containerDimensions;
      root.style.width = Number.isFinite(width) ? "100%" : "";
      root.style.maxWidth = Number.isFinite(maxWidth) ? maxWidth + "px" : "";
      root.style.height = Number.isFinite(height) ? height + "px" : "";
      root.style.maxHeight = Number.isFinite(maxHeight) ? maxHeight + "px" : "";
    }
    if (ctx?.theme === "dark" || ctx?.theme === "light") root.style.colorScheme = ctx.theme;
    for (const [key, value] of Object.entries(ctx?.styles?.variables ?? {})) {
      if (
        /^--(?:color-(?:text|background|border)-[a-z-]+|font-sans)$/.test(key) &&
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
      if (mode === "chart" && data?.dimensions?.[0]?.startsWith("time:")) render();
    }
    size();
  });
  observer.observe(root);
  function receive(e) {
    const m = e.data;
    if (e.source !== window.parent || !m || m.jsonrpc !== "2.0") return;
    if (!ready && m.id === "init" && !m.method) {
      if (m.result?.protocolVersion !== "2026-01-26") {
        showMessage("Connection unavailable", "The host could not open this result.");
        return;
      }
      ready = true;
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
        ready = false;
        observer.disconnect();
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
