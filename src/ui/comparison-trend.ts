// Runs inside the analytics resource, which has no network access.
export const comparisonTrend = String.raw`
  const dayMs = 86_400_000;
  let canCallTools = false;
  let hostRequestId = 0;
  let trend;
  let selectedDay = 0;
  const requests = new Map();

  function dismissTrendOnEscape(event) {
    if (event.key === "Escape") {
      const tip = find(".trend-tooltip");
      if (tip) tip.hidden = true;
    }
  }
  document.addEventListener("keydown", dismissTrendOnEscape);

  function dailyWindow(range) {
    if (!/^\d{4}-\d\d-\d\d,\d{4}-\d\d-\d\d$/.test(range)) return;
    const [start, end] = range.split(",").map(date => Date.parse(date));
    const days = (end - start) / dayMs + 1;
    if (days >= 1 && days <= 366) return {start, days};
  }
  async function requestDays(range, metrics) {
    const {site_id, goal, page, property_filters} = input;
    const args = {site_id, goal, page, property_filters, metrics, date_range: range, granularity: "day"};
    const reply = await hostRequest("tools/call", {name: "get_timeseries", arguments: args});
    const value = reply?.structuredContent;
    if (value?.dimensions?.[0] !== "time:day" || !Array.isArray(value.results) || !Array.isArray(value.metrics))
      throw Error("Invalid daily readings");
    return value;
  }
  function hostRequest(method, params) {
    const id = "view-" + ++hostRequestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { requests.delete(id); reject(); }, 30000);
      requests.set(id, message => {
        clearTimeout(timer);
        if (message.error || message.result?.isError || !message.result) reject();
        else resolve(message.result);
      });
      send({id, method, params});
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
    const max = Math.max(...numbers, 0), min = Math.min(...numbers, 0);
    const roughStep = (max - min || 3) / 3;
    const power = 10 ** Math.floor(Math.log10(roughStep));
    const fraction = roughStep / power;
    const unit = durations.has(key) || ["visitors", "visits", "pageviews", "events"].includes(key) ? 1 : 0.01;
    const step = Math.max(unit, (fraction < 1.5 ? 1 : fraction < 3.5 ? 2 : fraction < 7.5 ? 5 : 10) * power);
    const lowTick = Math.floor(min / step), highTick = Math.max(lowTick + 1, Math.ceil(max / step));
    const low = lowTick * step, high = highTick * step;
    const legend = node("div", undefined, "trend-legend");
    const plot = node("div", undefined, "trend-plot");
    const svg = elSvg("svg", {
      class: "plot", role: "slider", tabindex: 0,
      "aria-label": nice(key) + " by day of period. Baseline dashed, comparison solid.",
      "aria-valuemin": 1, "aria-valuemax": days,
    });
    plot.append(svg);
    output.append(legend, plot);
    const width = Math.max(180, plot.clientWidth), height = svg.clientHeight;
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    const left = Math.max(format(high, key).length, format(low, key).length) * 8 + 8;
    const right = width - 9, bottom = height - 35;
    const x = i => days === 1 ? (left + right) / 2 : left + i * (right - left) / (days - 1);
    const y = v => bottom - (v - low) / (high - low) * (bottom - 13);
    for (let tick = lowTick; tick <= highTick; tick++) {
      const v = tick * step;
      svg.append(elSvg("line", {x1:left, x2:right, y1:y(v), y2:y(v), stroke:"var(--line)"}),
        elSvg("text", {x:left-6, y:y(v)+4, "text-anchor":"end"}, format(v,key)));
    }
    values.forEach((series, i) => {
      const label = i ? "Comparison" : "Baseline";
      const color = i ? "var(--accent)" : "var(--sub)";
      legend.append(node("span", label + " · " + rangeLabel(i ? data.period_b.range : data.period_a.range), i ? "trend-swatch" : "trend-swatch dashed"));
      let path = "";
      series.forEach((v, j) => {
        if (!number(v)) return;
        const starts = !number(series[j-1]);
        path += (starts ? " M" : " L") + x(j) + " " + y(v);
        if (starts && !number(series[j+1])) svg.append(elSvg("circle",{cx:x(j),cy:y(v),r:3,fill:color}));
      });
      svg.append(elSvg("path",{d:path,fill:"none",stroke:color,"stroke-width":2.5,"stroke-dasharray":i ? "none" : "5 4"}));
    });
    const dayTicks = (right - left) / (days - 1) >= 50
      ? Array.from({length: days}, (_, i) => i)
      : [...new Set([0, days - 1])];
    for (const day of dayTicks) {
      const anchor = days === 1 ? "middle" : day === 0 ? "start" : day === days - 1 ? "end" : "middle";
      svg.append(elSvg("text", {x:x(day), y:height-10, "text-anchor":anchor}, "Day " + (day + 1)));
    }
    const guide = elSvg("g", {class:"trend-guide", "aria-hidden":"true"});
    const rule = elSvg("line", {y1:10, y2:bottom, stroke:"var(--sub)", "stroke-opacity":0.55});
    guide.append(rule);
    svg.append(guide);
    const tip = node("div", undefined, "trend-tooltip");
    // The slider's value text announces the same readings in a single utterance.
    tip.setAttribute("aria-hidden", "true");
    tip.hidden = true;
    const title = node("div", undefined, "tip-title");
    tip.append(title);
    const rows = ["Baseline", "Comparison"].map((name, index) => {
      const date = node("span", undefined, "tip-date");
      const value = node("strong", undefined, "tip-number");
      const seriesLabel = node("span", undefined, index ? "trend-swatch" : "trend-swatch dashed");
      seriesLabel.append(node("span", name, "tip-series"));
      tip.append(seriesLabel, date, value);
      const dot = elSvg("circle", {r:index ? 3 : 5, fill:index ? "var(--accent)" : "var(--paper)",
        stroke:index ? "var(--paper)" : "var(--sub)", "stroke-width":1.5});
      guide.append(dot);
      return {name, date, value, dot};
    });
    const change = node("div", undefined, "tip-change");
    const difference = node("strong", undefined, "tip-number");
    change.append(node("span", "Change"), difference);
    tip.append(change);
    plot.append(tip);

    const pin = dayAction(key, periods, values);
    const years = [data.period_a.range, data.period_b.range].flatMap(range => range.split(",").map(date => date.slice(0, 4)));
    const dateLabel = new Intl.DateTimeFormat(undefined, {month:"short", day:"numeric", timeZone:"UTC",
      year:new Set(years).size > 1 ? "numeric" : undefined});
    function inspect(day, show = true) {
      selectedDay = Math.max(0, Math.min(days - 1, day));
      const dayLabel = "Day " + (selectedDay + 1);
      title.textContent = dayLabel + " · " + nice(key);
      const px = x(selectedDay);
      rule.setAttribute("x1", px);
      rule.setAttribute("x2", px);
      const readings = [dayLabel], points = [];
      rows.forEach(({name, date, value, dot}, index) => {
        const period = periods[index], v = values[index][selectedDay];
        const inPeriod = selectedDay < period.days;
        date.textContent = inPeriod ? dateLabel.format(period.start + selectedDay * dayMs) : "Outside period";
        value.textContent = format(v, key);
        readings.push(inPeriod ? name + " " + date.textContent + ": " + (number(v) ? value.textContent : "no reading")
          : name + ": outside period");
        dot.style.display = number(v) ? "" : "none";
        if (number(v)) {
          points.push(y(v));
          dot.setAttribute("cx", px);
          dot.setAttribute("cy", y(v));
        }
      });
      const a = values[0][selectedDay], b = values[1][selectedDay];
      change.hidden = !number(a) || !number(b);
      if (!change.hidden) {
        difference.textContent = formatChange(b - a, key);
        readings.push("Change: " + difference.textContent);
      }
      svg.setAttribute("aria-valuenow", selectedDay + 1);
      svg.setAttribute("aria-valuetext", readings.join(" · "));
      tip.hidden = !show;
      if (!show) return;
      const gap = 10, inset = 4, w = tip.offsetWidth, h = tip.offsetHeight;
      const upper = points.length ? Math.min(...points) : bottom / 2;
      const lower = points.length ? Math.max(...points) : upper;
      const nextLeft = px + gap + w <= plot.clientWidth - inset ? px + gap : px - w - gap;
      const nextTop = lower - upper >= h + 2 * gap ? (lower + upper - h) / 2
        : height - lower >= upper ? lower + gap : upper - h - gap;
      tip.style.left = "clamp(4px, " + nextLeft + "px, calc(100% - " + (w + inset) + "px))";
      tip.style.top = "clamp(4px, " + nextTop + "px, calc(100% - " + (h + inset) + "px))";
    }
    function inspectPointer(event) {
      if (event.type === "pointermove" && event.pointerType === "mouse" && tip.contains(event.target)) return;
      const bounds = svg.getBoundingClientRect();
      const position = (event.clientX - bounds.left) * width / bounds.width;
      const day = Math.round((position - left) / (right - left) * (days - 1));
      if (tip.hidden || day !== selectedDay) inspect(day);
    }
    plot.onpointermove = inspectPointer;
    plot.onpointerdown = event => {
      svg.focus({preventScroll:true});
      inspectPointer(event);
    };
    plot.onclick = () => pin(selectedDay);
    plot.onpointerleave = event => {
      if (event.pointerType === "mouse") inspect(pinnedDay ?? selectedDay, svg.matches(":focus-visible"));
    };
    svg.onfocus = () => inspect(selectedDay);
    svg.onblur = plot.onpointercancel = () => { tip.hidden = true; };
    svg.onkeydown = event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); pin(selectedDay); return; }
      const next = {ArrowLeft: selectedDay - 1, ArrowDown: selectedDay - 1,
        ArrowRight: selectedDay + 1, ArrowUp: selectedDay + 1, Home: 0, End: days - 1}[event.key];
      if (next === undefined) return;
      event.preventDefault();
      inspect(next);
      pin(selectedDay);
    };
    inspect(selectedDay, false);
  }
`;
