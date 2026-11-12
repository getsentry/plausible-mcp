// Runs inside the analytics resource, which has no network access.
export const comparisonTrend = String.raw`
  const dayMs = 86_400_000;
  let canCallTools = false;
  let trendRequest = 0;
  let trend;
  let selectedDay = 0;
  const requests = new Map();

  function dailyWindow(range) {
    if (!/^\d{4}-\d\d-\d\d,\d{4}-\d\d-\d\d$/.test(range)) return;
    const [start, end] = range.split(",").map(date => Date.parse(date));
    const days = (end - start) / dayMs + 1;
    if (days >= 1 && days <= 366) return {start, days};
  }
  function requestDays(range, metrics) {
    const {site_id, goal, page, property_filters} = input;
    const args = {site_id, goal, page, property_filters, metrics, date_range: range, granularity: "day"};
    const id = "daily-" + ++trendRequest;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.delete(id);
        reject();
      }, 30000);
      requests.set(id, (message) => {
        clearTimeout(timer);
        const value = message.result?.structuredContent;
        if (message.error || message.result?.isError || value?.dimensions?.[0] !== "time:day" ||
            !Array.isArray(value.results) || !Array.isArray(value.metrics)) reject();
        else resolve(value);
      });
      send({method: "tools/call", id, params: {name: "get_timeseries", arguments: args}});
    });
  }
  async function loadTrend() {
    const current = data;
    trend = {};
    render();
    try {
      const metrics = metricNames(current);
      const series = await Promise.all([current.period_a, current.period_b].map(p => requestDays(p.range, metrics)));
      if (current !== data) return;
      trend = {series};
    } catch {
      if (current !== data) return;
      trend = {error: true};
    }
    if (mode === "trend") render();
  }
  function drawTrend(key) {
    if (!trend?.series) {
      output.append(node("p", trend?.error ? "The daily readings could not be loaded." : "Loading daily readings…", "detail"));
      if (trend?.error) {
        const retry = node("button", "Try again");
        retry.onclick = loadTrend;
        output.append(retry);
      }
      return;
    }
    const periods = [data.period_a, data.period_b].map(p => dailyWindow(p.range));
    const days = Math.max(...periods.map(p => p.days));
    const values = trend.series.map((series, i) => {
      const result = Array(periods[i].days).fill(null);
      const metric = series.metrics.indexOf(key);
      for (const row of series.results) {
        const day = (Date.parse(row.dimensions[0]) - periods[i].start) / dayMs;
        if (Number.isInteger(day) && day >= 0 && day < result.length) result[day] = row.metrics[metric];
      }
      return result;
    });
    const numbers = values.flat().filter(number);
    if (!numbers.length) {
      output.append(node("p", "No daily observations for this metric.", "detail"));
      return;
    }
    const high = Math.max(...numbers, 0), low = Math.min(...numbers, 0);
    const width = Math.max(180, output.clientWidth);
    const left = Math.max(format(high, key).length, format(low, key).length) * 8 + 8;
    const right = width - 9, bottom = 141;
    const x = i => days === 1 ? (left + right) / 2 : left + i * (right - left) / (days - 1);
    const y = v => bottom - (v - low) / (high - low || 1) * 128;
    const legend = node("div", undefined, "trend-legend");
    const svg = elSvg("svg", {class: "plot", viewBox: "0 0 " + width + " 176", role: "img", "aria-label": nice(key) + " by day of period. Baseline dashed, comparison solid."});
    for (const v of new Set([low, high])) {
      svg.append(elSvg("line", {x1:left, x2:right, y1:y(v), y2:y(v), stroke:"var(--line)"}),
        elSvg("text", {x:left-6, y:y(v)+4, "text-anchor":"end"}, format(v,key)));
    }
    values.forEach((series, i) => {
      const label = i ? "Comparison" : "Baseline";
      const color = i ? "var(--accent)" : "var(--sub)";
      legend.append(node("span", label + " · " + rangeLabel(i ? data.period_b.range : data.period_a.range), i ? "solid" : "dashed"));
      let path = "";
      series.forEach((v, j) => {
        if (!number(v)) return;
        const starts = !number(series[j-1]);
        path += (starts ? " M" : " L") + x(j) + " " + y(v);
        if (starts && !number(series[j+1])) svg.append(elSvg("circle",{cx:x(j),cy:y(v),r:3,fill:color}));
      });
      svg.append(elSvg("path",{d:path,fill:"none",stroke:color,"stroke-width":2.5,"stroke-dasharray":i ? "none" : "5 4"}));
    });
    svg.append(elSvg("text",{x:left,y:166},"Day 1"));
    if (days > 1) svg.append(elSvg("text",{x:right,y:166,"text-anchor":"end"},"Day " + days));
    const slider = node("input");
    slider.type = "range";
    slider.min = 1;
    slider.max = days;
    slider.setAttribute("aria-label", "Inspect day of period");
    const readout = node("p", undefined, "detail");
    const guide = elSvg("line",{y1:10,y2:bottom,stroke:"var(--sub)","stroke-opacity":0.45});
    svg.append(guide);
    function inspect(i) {
      selectedDay = Math.max(0, Math.min(days - 1, i));
      slider.value = selectedDay + 1;
      const label = "Day " + slider.value + " · Baseline " + format(values[0][selectedDay], key) + " · Comparison " + format(values[1][selectedDay], key);
      readout.textContent = label;
      slider.setAttribute("aria-valuetext", label);
      guide.setAttribute("x1", x(selectedDay));
      guide.setAttribute("x2", x(selectedDay));
    }
    slider.oninput = () => inspect(Number(slider.value) - 1);
    svg.onpointermove = e => inspect(Math.round((e.clientX - svg.getBoundingClientRect().left - left) / (right-left) * (days-1)));
    inspect(selectedDay);
    output.append(legend, svg, slider, readout);
  }
`;
