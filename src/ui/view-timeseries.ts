// The timeseries line chart and its keyboard and pointer inspection, for the analytics view script.
// Runs inside the analytics resource, which has no network access. It shares the
// script scope of view.ts, which inserts it.
export const viewTimeseries = String.raw`
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
      values = rows.map((r) => amount(r.metrics[select.selectedIndex]));
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
      headline.textContent = format(rows[point].metrics[select.selectedIndex], key);
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
`;
