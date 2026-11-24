// The data table, its paging, and the ranked bar chart for the analytics view script.
// Runs inside the analytics resource, which has no network access. It shares the
// script scope of view.ts, which inserts it.
export const viewTables = String.raw`
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
      ...rows.map((r) => (number(amount(r.metrics[select.selectedIndex])) ? amount(r.metrics[select.selectedIndex]) : 0)),
    );
    const list = node("ol", undefined, "ranking");
    for (const row of rows) {
      const item = node("li", undefined, "rank"),
        value = row.metrics[select.selectedIndex];
      const label = node("span", rowLabel(row), "rank-label");
      const share = max && number(amount(value)) ? Math.max(0, amount(value)) / max : 0;
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
`;
