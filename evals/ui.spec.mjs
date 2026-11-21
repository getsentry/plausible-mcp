import { expect, hoverTimeAxis, preview, test, view } from "./ui-fixtures.mjs";

test("timeseries accepts keyboard and pointer input and pages all returned rows", async ({
  app,
}) => {
  await app.getByLabel("Metric").selectOption("bounce_rate");
  const plot = app.locator(".plot");
  await expect(plot).toHaveAccessibleName(/Oct 14, 38%/);
  await plot.press("Home");
  await expect(plot).toHaveAccessibleName(/Oct 1, 52%/);
  await plot.press("ArrowRight");
  await expect(plot).toHaveAccessibleName(/Oct 2, 45%/);
  await hoverTimeAxis(plot, 1);
  await expect(plot).toHaveAccessibleName(/Oct 14, 38%/);
  await app.getByRole("button", { name: "Data", exact: true }).click();
  await expect(app.locator("tbody tr")).toHaveCount(12);
  await app.getByRole("button", { name: "Next" }).press("Enter");
  await expect(app.locator("tbody tr")).toHaveCount(2);
  await expect(app.getByRole("row").last()).toHaveText("2026-10-1432767138%");
  await expect(app.getByRole("button", { name: "Previous" })).toBeFocused();
});

test("host theme and width changes update the same chart and keep the table inside the frame", async ({
  page,
  app,
}) => {
  await app.getByLabel("Metric").selectOption("bounce_rate");
  await page.getByLabel("Theme").selectOption("dark");
  const surface = app.locator("#plausible-app");
  await expect(surface).toHaveCSS("color-scheme", "dark");
  await page.getByLabel("Width").selectOption("320px");
  await expect(page.locator("iframe")).toHaveCSS("width", "320px");
  await expect(app.getByLabel("Metric")).toHaveValue("bounce_rate");
  await expect
    .poll(() =>
      app
        .locator(".plot")
        .evaluate(
          (svg) => svg.viewBox.baseVal.width === Math.floor(svg.getBoundingClientRect().width),
        ),
    )
    .toBe(true);
  await app.getByRole("button", { name: "Data", exact: true }).click();
  await expect
    .poll(() =>
      app
        .locator("body")
        .evaluate(
          (body) => body.scrollWidth <= body.clientWidth && body.scrollHeight <= innerHeight,
        ),
    )
    .toBe(true);
});

test("breakdown and conversion bars retain their dimension labels and metric units", async ({
  page,
  app,
}) => {
  const tool = page.getByRole("combobox", { name: "Tool", exact: true });
  await tool.selectOption("get_breakdown");
  await expect(app.getByRole("heading")).toHaveText("Top pages");
  await expect(app.locator(".rank")).toHaveCount(5);
  await expect(app.locator(".rank").first()).toHaveText("/804");
  await app.getByRole("button", { name: "Data", exact: true }).click();
  await expect(app.getByText(/more rows are available/i)).toContainText("offset 5");
  await tool.selectOption("get_conversions");
  await expect(app.getByRole("heading")).toHaveText("Goal conversions");
  await expect(app.locator(".rank").first()).toHaveText("Signup · /pricing7.8%");
  await app.getByLabel("Metric").selectOption("events");
  await expect(app.locator(".rank").first()).toHaveText("Signup · /pricing52");
});

for (const width of ["100%", "320px"]) {
  test("Top pages keeps its toolbar and results in place at " + width, async ({ page, app }) => {
    await page.getByLabel("Width").selectOption(width);
    await page.getByRole("combobox", { name: "Tool", exact: true }).selectOption("get_breakdown");
    await expect(app.locator(".rank")).toHaveCount(5);
    const buttons = app.getByRole("group", { name: "Result view" });
    const initialButtons = await buttons.boundingBox();
    const resultTop = (await app.locator(".result").boundingBox()).y;
    for (const mode of ["Data", "Chart"]) {
      const button = buttons.getByRole("button", { name: mode });
      await button.click();
      await expect(button).toHaveAttribute("aria-pressed", "true");
      expect(await buttons.boundingBox()).toEqual(initialButtons);
      expect((await app.locator(".result").boundingBox()).y).toBe(resultTop);
    }
  });
}

test("site labels containing markup render literally", async ({ page, app }) => {
  await page.getByRole("combobox", { name: "Tool", exact: true }).selectOption("get_breakdown");
  await expect(app.getByRole("heading")).toHaveText("Top pages");
  await page.evaluate(() =>
    document.querySelector("iframe").contentWindow.postMessage(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: {
          content: [],
          structuredContent: {
            metrics: ["visitors"],
            dimensions: ["event:page"],
            results: [{ dimensions: ["/docs/<b>draft</b>"], metrics: [12] }],
          },
        },
      },
      "*",
    ),
  );
  await expect(app.locator(".rank-label")).toHaveText("/docs/<b>draft</b>");
  await expect(app.locator(".rank-label b")).toHaveCount(0);
});

test("period comparison distinguishes percentage points, relative change and missing baselines", async ({
  page,
  app,
}) => {
  const tool = page.getByRole("combobox", { name: "Tool", exact: true });
  await tool.selectOption("compare_periods");
  await expect(app.getByRole("heading")).toHaveText("Period comparison");
  await expect(app.locator(".value")).toHaveText(["2,710", "3,124"]);
  await expect(app.locator(".result")).toContainText("+414 (15.28%)");
  await app.getByLabel("Metric").selectOption("bounce_rate");
  await expect(app.locator(".result")).toContainText("-5.3 pp (-10.93%)");
  await app.getByRole("button", { name: "Data", exact: true }).click();
  await expect(app.getByRole("row", { name: /Bounce rate/ })).toContainText(
    "48.5%43.2%-5.3 pp-10.93%",
  );
  await page.getByLabel("State").selectOption("Empty baseline");
  await expect(app.locator(".value")).toHaveText(["—", "24"]);
  await expect(app.locator(".result")).toContainText("Relative change unavailable");
});

test("hourly traffic places omitted buckets, nulls and zeroes correctly", async ({ page, app }) => {
  await page.getByLabel("State").selectOption({ label: "Hourly traffic" });
  const plot = app.locator(".plot");
  await expect(plot).toHaveAccessibleName(/08:00, 12/);
  await hoverTimeAxis(plot, 1 / 4);
  await expect(plot).toHaveAccessibleName(/02:00, 7/);
  const line = await plot.locator('path[fill="none"]').getAttribute("d");
  expect(line.match(/M/g)).toHaveLength(3);
  await plot.press("Home");
  await expect(plot).toHaveAccessibleName(/00:00, 0/);
  await plot.press("ArrowRight");
  await expect(plot).toHaveAccessibleName(/01:00, —/);
});

for (const [label, middle] of [
  ["Weekly traffic", /Oct 5, 2/],
  ["Monthly traffic", /Jan 1, 2/],
]) {
  test(label + " uses calendar buckets for partial periods and gaps", async ({ page, app }) => {
    await page.getByLabel("State").selectOption({ label });
    const plot = app.locator(".plot");
    await hoverTimeAxis(plot, 1 / 3);
    await expect(plot).toHaveAccessibleName(middle);
    expect((await plot.locator('path[fill="none"]').getAttribute("d")).match(/M/g)).toHaveLength(2);
  });
}

test("each tool can show its pending, cancelled and failed states", async ({ page, app }) => {
  const tool = page.getByRole("combobox", { name: "Tool", exact: true });
  const state = page.getByLabel("State");
  for (const name of [
    "get_timeseries",
    "get_breakdown",
    "get_conversions",
    "compare_periods",
    "send_feedback",
  ]) {
    await tool.selectOption(name);
    await state.selectOption("loading");
    await expect(app.locator('.result[aria-busy="true"]')).toHaveText(
      name === "send_feedback" ? "Sending feedback…" : "Loading results…",
    );
    await state.selectOption("cancelled");
    await expect(app.getByRole("heading")).toHaveText(
      name === "send_feedback" ? "Feedback cancelled" : "Query cancelled",
    );
    if (name !== "send_feedback") {
      await state.selectOption("Empty result");
      await expect(app.locator(".result")).toHaveText("No results for this query.");
      await expect(app.getByLabel("Metric")).toBeHidden();
    }
    await state.selectOption(name === "send_feedback" ? "Feedback error" : "Query error");
    await expect(app.getByRole("heading")).toHaveText(
      name === "send_feedback" ? "Feedback failed" : "Query failed",
    );
    if (name === "get_timeseries") {
      await expect(app.locator(".result")).toContainText("This fixture site is unavailable.");
    }
  }
  // The successful feedback result shows the id Sentry returned.
  await tool.selectOption("send_feedback");
  await state.selectOption(await state.locator("option").first().getAttribute("value"));
  await expect(app.getByRole("heading")).toHaveText("Feedback received");
  const id = await page
    .locator("#fixtures")
    .evaluate(
      (el) =>
        JSON.parse(el.textContent).scenarios.find((s) => s.tool.name === "send_feedback").result
          .structuredContent.feedback_id,
    );
  await expect(app.locator("code")).toHaveText(id);
});

test("daily comparison preserves missing days and reads both periods through the host", async ({
  page,
  app,
}) => {
  await page.getByRole("combobox", { name: "Tool", exact: true }).selectOption("compare_periods");
  await app.getByRole("button", { name: "Daily trend" }).click();
  const plot = app.getByRole("slider", { name: /by day of period/ });
  await expect(app.locator("input[type=range]")).toHaveCount(0);
  const tip = app.locator(".trend-tooltip");
  await expect(tip).toBeHidden();
  await expect(plot).toHaveAttribute(
    "aria-valuetext",
    "Day 1 · Baseline Sep 17: 19 · Comparison Oct 1: 23 · Change: +4",
  );
  await hoverTimeAxis(plot, 0);
  await expect(tip).toBeVisible();
  await expect(tip.locator(".tip-number")).toHaveText(["19", "23", "+4"]);
  await tip.hover();
  await expect(plot).toHaveAttribute("aria-valuenow", "1");
  await app.getByRole("heading").hover();
  await expect(tip).toBeHidden();
  await hoverTimeAxis(plot, 1);
  await expect(plot).toHaveAttribute("aria-valuenow", "14");
  await plot.press("Home");
  await expect(tip).toBeVisible();
  await plot.press("Escape");
  await expect(tip).toBeHidden();
  await plot.press("ArrowRight");
  await expect(plot).toHaveAttribute(
    "aria-valuetext",
    "Day 2 · Baseline Sep 18: no reading · Comparison Oct 2: no reading",
  );
  await expect(tip.locator(".tip-change")).toBeHidden();
  await expect(tip.locator(".tip-number").first()).toHaveText("—");
  await plot.press("ArrowRight");
  await app.getByLabel("Metric").selectOption("bounce_rate");
  await expect(plot).toHaveAttribute(
    "aria-valuetext",
    "Day 3 · Baseline Sep 19: no reading · Comparison Oct 3: 39%",
  );
  await page.getByLabel("Width").selectOption("320px");
  await expect
    .poll(() =>
      plot.evaluate(
        (el) => el.viewBox.baseVal.width === Math.floor(el.getBoundingClientRect().width),
      ),
    )
    .toBe(true);
  for (const key of ["Home", "End"]) {
    await plot.press(key);
    await expect(tip).toBeVisible();
    const { box, bounds } = await tip.evaluate((el) => ({
      box: el.getBoundingClientRect().toJSON(),
      bounds: el.parentElement.getBoundingClientRect().toJSON(),
    }));
    expect(box.left).toBeGreaterThanOrEqual(bounds.left);
    expect(box.right).toBeLessThanOrEqual(bounds.right);
    expect(box.top).toBeGreaterThanOrEqual(bounds.top);
    expect(box.bottom).toBeLessThanOrEqual(bounds.bottom);
  }
  await plot.press("Home");
  await expect(tip.locator(".tip-change")).toHaveText("Change+4 pp");
  for (let day = 0; day < 4; day++) {
    expect(
      await plot.evaluate((svg) => {
        const tip = svg.nextElementSibling.getBoundingClientRect();
        return Array.from(svg.querySelectorAll(".trend-guide circle")).every((dot) => {
          const point = dot.getBoundingClientRect();
          return (
            !point.width ||
            point.right < tip.left ||
            point.left > tip.right ||
            point.bottom < tip.top ||
            point.top > tip.bottom
          );
        });
      }),
    ).toBe(true);
    await plot.press("ArrowRight");
  }
  await plot.press("Tab");
  await expect(tip).toBeHidden();
  await app.getByRole("button", { name: "Summary" }).click();
  await expect(app.locator(".value")).toHaveText(["48.5%", "43.2%"]);
});

test("a host without tool-call support still shows the comparison summary and table", async ({
  page,
}) => {
  await page.goto(preview + "?display-only");
  await page.getByRole("combobox", { name: "Tool", exact: true }).selectOption("compare_periods");
  const app = view(page);
  await expect(app.getByRole("heading")).toHaveText("Period comparison");
  await expect(app.getByRole("button", { name: "Daily trend" })).toBeHidden();
  await expect(app.locator(".value")).toHaveText(["2,710", "3,124"]);
  await app.getByRole("button", { name: "Data", exact: true }).click();
  await expect(app.getByRole("row", { name: /Bounce rate/ })).toContainText("48.5%43.2%");
});

test("a comparison without its tool input offers no daily reads", async ({ page }) => {
  await page.goto(preview + "?no-input");
  await page.getByRole("combobox", { name: "Tool", exact: true }).selectOption("compare_periods");
  const app = view(page);
  await expect(app.getByRole("heading")).toHaveText("Period comparison");
  await expect(app.locator(".value")).toHaveText(["2,710", "3,124"]);
  await expect(app.getByRole("button", { name: "Daily trend" })).toBeHidden();
});

test.describe("touch inspection", () => {
  test.use({ hasTouch: true });
  test("a tap selects a comparison day directly on the plot", async ({ page, app }) => {
    await page.getByRole("combobox", { name: "Tool", exact: true }).selectOption("compare_periods");
    await app.getByRole("button", { name: "Daily trend" }).tap();
    const plot = app.getByRole("slider", { name: /by day of period/ });
    const bounds = await plot.boundingBox();
    await plot.tap({ position: { x: Math.floor(bounds.width - 12), y: 55 } });
    await expect(plot).toHaveAttribute("aria-valuenow", "14");
    await plot.tap({ position: { x: 8, y: 55 } });
    await expect(plot).toHaveAttribute("aria-valuenow", "1");
    await expect(app.locator(".trend-tooltip")).toBeVisible();
    await expect(app.locator(".tip-date")).toHaveText(["Sep 17", "Oct 1"]);
  });
});
