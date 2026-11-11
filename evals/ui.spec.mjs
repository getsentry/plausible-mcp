import { test as base, expect } from "@playwright/test";

const preview = new URL("../coverage/ui-review/index.html", import.meta.url).href;
const test = base.extend({
  app: async ({ page }, use) => {
    const errors = [];
    const network = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("request", (request) => {
      if (/^https?:/.test(request.url())) network.push(request.url());
    });
    await page.goto(preview);
    const app = page.frameLocator('iframe[title="Plausible Analytics"]');
    await expect(app.getByRole("heading", { name: "Traffic over time" })).toBeVisible();
    await use(app);
    expect(errors).toEqual([]);
    expect(network).toEqual([]);
  },
});

async function hoverTimeAxis(plot, fraction) {
  const x = await plot.locator("line").first().evaluate((line, fraction) => {
    const left = line.x1.baseVal.value;
    return left + (line.x2.baseVal.value - left) * fraction;
  }, fraction);
  await plot.hover({ position: { x, y: 70 } });
}

test("timeseries accepts keyboard and pointer input and pages all returned rows", async ({ app }) => {
  await app.getByLabel("Metric").selectOption("bounce_rate");
  const plot = app.locator(".plot");
  await expect(plot).toHaveAccessibleName(/Oct 14, 38%/);
  await plot.press("Home");
  await expect(plot).toHaveAccessibleName(/Oct 1, 52%/);
  await plot.press("ArrowRight");
  await expect(plot).toHaveAccessibleName(/Oct 2, 45%/);
  const box = await plot.boundingBox();
  await plot.hover({ position: { x: box.width - 10, y: 80 } });
  await expect(plot).toHaveAccessibleName(/Oct 14, 38%/);
  await app.getByRole("button", { name: "Data", exact: true }).click();
  await expect(app.locator("tbody tr")).toHaveCount(12);
  await app.getByRole("button", { name: "Next" }).click();
  await expect(app.locator("tbody tr")).toHaveCount(2);
  await expect(app.getByRole("row").last()).toHaveText("2026-10-1432767138%");
  await expect(app.getByRole("button", { name: "Previous" })).toBeFocused();
});

test("host theme and width changes update the same chart and keep the table inside the frame", async ({ page, app }) => {
  await app.getByLabel("Metric").selectOption("bounce_rate");
  await page.getByLabel("Theme").selectOption("dark");
  await expect(app.locator("#plausible-app")).toHaveCSS("color-scheme", "dark");
  await page.getByLabel("Width").selectOption("320px");
  await expect(page.locator("iframe")).toHaveCSS("width", "320px");
  await expect(app.getByLabel("Metric")).toHaveValue("bounce_rate");
  await expect.poll(() => app.locator(".plot").evaluate((svg) =>
    svg.viewBox.baseVal.width === Math.floor(svg.getBoundingClientRect().width)
  )).toBe(true);
  await app.getByRole("button", { name: "Data", exact: true }).click();
  await expect.poll(() => app.locator("body").evaluate((body) =>
    body.scrollWidth <= body.clientWidth && body.scrollHeight <= innerHeight
  )).toBe(true);
});

test("breakdown and conversion bars retain their dimension labels and metric units", async ({ page, app }) => {
  const sample = page.getByLabel("Sample result");
  await sample.selectOption({ label: "Pages" });
  await expect(app.getByRole("heading")).toHaveText("Breakdown by page");
  await expect(app.locator(".rank")).toHaveCount(5);
  await expect(app.locator(".rank").first()).toHaveText("/804");
  await app.getByRole("button", { name: "Data", exact: true }).click();
  await expect(app.getByText(/more rows are available/i)).toContainText("offset 5");
  await sample.selectOption({ label: "Conversions" });
  await expect(app.getByRole("heading")).toHaveText("Goal conversions");
  await expect(app.locator(".rank").first()).toHaveText("Signup · /pricing7.8%");
  await app.getByLabel("Metric").selectOption("events");
  await expect(app.locator(".rank").first()).toHaveText("Signup · /pricing52");
});

test("period comparison distinguishes percentage points, relative change and missing baselines", async ({ page, app }) => {
  const sample = page.getByLabel("Sample result");
  await sample.selectOption({ label: "Compare periods" });
  await expect(app.getByRole("heading")).toHaveText("Period comparison");
  await expect(app.locator(".value")).toHaveText(["2,710", "3,124"]);
  await expect(app.locator(".result")).toContainText("+414 (15.28%)");
  await app.getByLabel("Metric").selectOption("bounce_rate");
  await expect(app.locator(".result")).toContainText("-5.3 pp (-10.93%)");
  await app.getByRole("button", { name: "Data", exact: true }).click();
  await expect(app.getByRole("row", { name: /Bounce rate/ })).toContainText("48.5%43.2%-5.3 pp-10.93%");
  await sample.selectOption({ label: "Empty baseline" });
  await expect(app.locator(".value")).toHaveText(["—", "24"]);
  await expect(app.locator(".result")).toContainText("Relative change unavailable");
});

test("hourly traffic places omitted buckets, nulls and zeroes correctly", async ({ page, app }) => {
  await page.getByLabel("Sample result").selectOption({ label: "Hourly traffic" });
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

for (const [label, middle] of [["Weekly traffic", /Oct 5, 2/], ["Monthly traffic", /Jan 1, 2/]]) {
  test(label + " uses calendar buckets for partial periods and gaps", async ({ page, app }) => {
    await page.getByLabel("Sample result").selectOption({ label });
    const plot = app.locator(".plot");
    await hoverTimeAxis(plot, 1 / 3);
    await expect(plot).toHaveAccessibleName(middle);
    expect((await plot.locator('path[fill="none"]').getAttribute("d")).match(/M/g)).toHaveLength(2);
  });
}

test("feedback, empty and failed calls each show the corresponding result", async ({ page, app }) => {
  const sample = page.getByLabel("Sample result");
  await sample.selectOption({ label: "Feedback receipt" });
  await expect(app.getByRole("heading")).toHaveText("Feedback received");
  const id = await page.locator("#fixtures").evaluate((el) =>
    JSON.parse(el.textContent).scenarios.find((s) => s.tool.name === "send_feedback").result.structuredContent.feedback_id
  );
  await expect(app.locator("code")).toHaveText(id);
  await sample.selectOption({ label: "Empty result" });
  await expect(app.locator(".result")).toHaveText("No results for this query.");
  await expect(app.getByLabel("Metric")).toBeHidden();
  await sample.selectOption({ label: "Query error" });
  await expect(app.getByRole("heading")).toHaveText("Query failed");
  await expect(app.locator(".result")).toContainText("This fixture site is unavailable.");
});
