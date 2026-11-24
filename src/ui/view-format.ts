// Value formatting, DOM helpers and labels for the analytics view script.
// Runs inside the analytics resource, which has no network access. It shares the
// script scope of view.ts, which inserts it.
export const viewFormatting = String.raw`
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
  const amount = (value) => value?.value ?? value;
  function format(value, key) {
    if (value && number(value.value)) return value.long + " " + value.currency;
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
    clearSelection();
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
`;
