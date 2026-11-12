import { test as base, expect } from "@playwright/test";

const preview = new URL("../coverage/ui-review/index.html", import.meta.url).href;
const view = page => page.frameLocator('iframe[title="Plausible Analytics"]').frameLocator('iframe[title="Analytics result"]');
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
    const app = view(page);
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
  await hoverTimeAxis(plot, 1);
  await expect(plot).toHaveAccessibleName(/Oct 14, 38%/);
  await app.getByRole("button", { name: "Data", exact: true }).click();
  await expect(app.locator("tbody tr")).toHaveCount(12);
  await app.getByRole("button", { name: "Next" }).press("Enter");
  await expect(app.locator("tbody tr")).toHaveCount(2);
  await expect(app.getByRole("row").last()).toHaveText("2026-10-1432767138%");
  await expect(app.getByRole("button", { name: "Previous" })).toBeFocused();
});

test("host theme and width changes update the same chart and keep the table inside the frame", async ({ page, app }) => {
  await app.getByLabel("Metric").selectOption("bounce_rate");
  await page.getByLabel("Theme").selectOption("dark");
  const surface = app.locator("#plausible-app");
  await expect(surface).toHaveCSS("color-scheme", "dark");
  await expect(surface).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(surface).toHaveCSS("border-top-left-radius", "0px");
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

test("site labels containing markup render literally", async ({page, app}) => {
  await page.getByRole("combobox", {name:"Tool", exact:true}).selectOption("get_breakdown");
  await expect(app.getByRole("heading")).toHaveText("Top pages");
  await page.evaluate(() => document.querySelector("iframe").contentWindow.postMessage({
    jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {
      content: [], structuredContent: {metrics:["visitors"], dimensions:["event:page"],
        results:[{dimensions:["/docs/<b>draft</b>"], metrics:[12]}]},
    },
  }, "*"));
  await expect(app.locator(".rank-label")).toHaveText("/docs/<b>draft</b>");
  await expect(app.locator(".rank-label b")).toHaveCount(0);
});

test("period comparison distinguishes percentage points, relative change and missing baselines", async ({ page, app }) => {
  const tool = page.getByRole("combobox", { name: "Tool", exact: true });
  await tool.selectOption("compare_periods");
  await expect(app.getByRole("heading")).toHaveText("Period comparison");
  await expect(app.locator(".value")).toHaveText(["2,710", "3,124"]);
  await expect(app.locator(".result")).toContainText("+414 (15.28%)");
  await app.getByLabel("Metric").selectOption("bounce_rate");
  await expect(app.locator(".result")).toContainText("-5.3 pp (-10.93%)");
  await app.getByRole("button", { name: "Data", exact: true }).click();
  await expect(app.getByRole("row", { name: /Bounce rate/ })).toContainText("48.5%43.2%-5.3 pp-10.93%");
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

for (const [label, middle] of [["Weekly traffic", /Oct 5, 2/], ["Monthly traffic", /Jan 1, 2/]]) {
  test(label + " uses calendar buckets for partial periods and gaps", async ({ page, app }) => {
    await page.getByLabel("State").selectOption({ label });
    const plot = app.locator(".plot");
    await hoverTimeAxis(plot, 1 / 3);
    await expect(plot).toHaveAccessibleName(middle);
    expect((await plot.locator('path[fill="none"]').getAttribute("d")).match(/M/g)).toHaveLength(2);
  });
}

test("feedback, empty and failed calls each show the corresponding result", async ({ page, app }) => {
  const tool = page.getByRole("combobox", { name: "Tool", exact: true });
  await tool.selectOption("send_feedback");
  await expect(app.getByRole("heading")).toHaveText("Feedback received");
  const id = await page.locator("#fixtures").evaluate((el) =>
    JSON.parse(el.textContent).scenarios.find((s) => s.tool.name === "send_feedback").result.structuredContent.feedback_id
  );
  await expect(app.locator("code")).toHaveText(id);
  await tool.selectOption("get_timeseries");
  await page.getByLabel("State").selectOption("Empty result");
  await expect(app.locator(".result")).toHaveText("No results for this query.");
  await expect(app.getByLabel("Metric")).toBeHidden();
  await page.getByLabel("State").selectOption("Query error");
  await expect(app.getByRole("heading")).toHaveText("Query failed");
  await expect(app.locator(".result")).toContainText("This fixture site is unavailable.");
});


test("each tool can show its pending, cancelled and failed states", async ({ page, app }) => {
  const tool = page.getByRole("combobox", { name: "Tool", exact: true });
  const state = page.getByLabel("State");
  for (const name of ["get_timeseries", "get_breakdown", "get_conversions", "compare_periods", "send_feedback"]) {
    await tool.selectOption(name);
    await state.selectOption("loading");
    await expect(app.locator('.result[aria-busy="true"]')).toHaveText(name === "send_feedback" ? "Sending feedback…" : "Loading results…");
    await state.selectOption("cancelled");
    await expect(app.getByRole("heading")).toHaveText(name === "send_feedback" ? "Feedback cancelled" : "Query cancelled");
    if (name !== "send_feedback") {
      await state.selectOption("Empty result");
      await expect(app.locator(".result")).toHaveText("No results for this query.");
    }
    await state.selectOption(name === "send_feedback" ? "Feedback error" : "Query error");
    await expect(app.getByRole("heading")).toHaveText(name === "send_feedback" ? "Feedback failed" : "Query failed");
  }
});

test("daily comparison preserves missing days and reads both periods through the host", async ({ page, app }) => {
  await page.getByRole("combobox", {name: "Tool", exact: true}).selectOption("compare_periods");
  await app.getByRole("button", {name: "Daily trend"}).click();
  const plot = app.getByRole("slider", {name: /by day of period/});
  await expect(app.locator("input[type=range]")).toHaveCount(0);
  const tip = app.locator(".trend-tooltip");
  await expect(tip).toBeHidden();
  await expect(plot).toHaveAttribute("aria-valuetext", "Day 1 · Baseline Sep 17: 19 · Comparison Oct 1: 23 · Change: +4");
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
  await expect(plot).toHaveAttribute("aria-valuetext", "Day 2 · Baseline Sep 18: no reading · Comparison Oct 2: no reading");
  await expect(tip.locator(".tip-change")).toBeHidden();
  await expect(tip.locator(".tip-number").first()).toHaveText("—");
  await plot.press("ArrowRight");
  await app.getByLabel("Metric").selectOption("bounce_rate");
  await expect(plot).toHaveAttribute("aria-valuetext", "Day 3 · Baseline Sep 19: no reading · Comparison Oct 3: 39%");
  await page.getByLabel("Width").selectOption("320px");
  await expect.poll(() => plot.evaluate(el => el.viewBox.baseVal.width === Math.floor(el.getBoundingClientRect().width))).toBe(true);
  for (const key of ["Home", "End"]) {
    await plot.press(key);
    await expect(tip).toBeVisible();
    const {box, bounds} = await tip.evaluate(el => ({
      box: el.getBoundingClientRect().toJSON(), bounds: el.parentElement.getBoundingClientRect().toJSON(),
    }));
    expect(box.left).toBeGreaterThanOrEqual(bounds.left);
    expect(box.right).toBeLessThanOrEqual(bounds.right);
    expect(box.top).toBeGreaterThanOrEqual(bounds.top);
    expect(box.bottom).toBeLessThanOrEqual(bounds.bottom);
  }
  await plot.press("Home");
  await expect(tip.locator(".tip-change")).toHaveText("Change+4 pp");
  for (let day = 0; day < 4; day++) {
    expect(await plot.evaluate(svg => {
      const tip = svg.nextElementSibling.getBoundingClientRect();
      return Array.from(svg.querySelectorAll(".trend-guide circle")).every(dot => {
        const point = dot.getBoundingClientRect();
        return !point.width || point.right < tip.left || point.left > tip.right ||
          point.bottom < tip.top || point.top > tip.bottom;
      });
    })).toBe(true);
    await plot.press("ArrowRight");
  }
  await plot.press("Tab");
  await expect(tip).toBeHidden();
  await app.getByRole("button", {name: "Summary"}).click();
  await expect(app.locator(".value")).toHaveText(["48.5%", "43.2%"]);
});

test("a host without tool-call support still shows the comparison summary and table", async ({page}) => {
  await page.goto(preview + "?display-only");
  await page.getByRole("combobox", {name: "Tool", exact: true}).selectOption("compare_periods");
  const app = view(page);
  await expect(app.getByRole("heading")).toHaveText("Period comparison");
  await expect(app.getByRole("button", {name: "Daily trend"})).toBeHidden();
  await expect(app.locator(".value")).toHaveText(["2,710", "3,124"]);
  await app.getByRole("button", {name: "Data", exact: true}).click();
  await expect(app.getByRole("row", {name: /Bounce rate/})).toContainText("48.5%43.2%");
});

test("a comparison without its tool input offers no daily reads", async ({page}) => {
  await page.goto(preview + "?no-input");
  await page.getByRole("combobox", {name: "Tool", exact: true}).selectOption("compare_periods");
  const app = view(page);
  await expect(app.getByRole("heading")).toHaveText("Period comparison");
  await expect(app.locator(".value")).toHaveText(["2,710", "3,124"]);
  await expect(app.getByRole("button", {name: "Daily trend"})).toBeHidden();
});

test.describe("touch inspection", () => {
  test.use({hasTouch: true});
  test("a tap selects a comparison day directly on the plot", async ({page, app}) => {
    await page.getByRole("combobox", {name:"Tool", exact:true}).selectOption("compare_periods");
    await app.getByRole("button", {name:"Daily trend"}).tap();
    const plot = app.getByRole("slider", {name:/by day of period/});
    const bounds = await plot.boundingBox();
    await plot.tap({position:{x: Math.floor(bounds.width - 12), y: 55}});
    await expect(plot).toHaveAttribute("aria-valuenow", "14");
    await plot.tap({position:{x: 8, y: 55}});
    await expect(plot).toHaveAttribute("aria-valuenow", "1");
    await expect(app.locator(".trend-tooltip")).toBeVisible();
    await expect(app.locator(".tip-date")).toHaveText(["Sep 17", "Oct 1"]);
  });
});

test("landing page renders the shipped app and switches installation instructions", async ({page}) => {
  const {landingHtml, landingSecurityPolicy} = await import("../dist/landing.js");
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://landing.example.test/", route => route.fulfill({
    body: landingHtml("https://landing.example.test/mcp"), headers: {"content-type":"text/html", "content-security-policy":landingSecurityPolicy},
  }));
  await page.setViewportSize({width: 375, height: 812});
  await page.goto("https://landing.example.test/");
  const app = page.frameLocator("iframe").frameLocator('iframe[title="Analytics result"]');
  const proxyFrame = page.frameLocator("iframe");
  const viewElement = proxyFrame.locator("iframe");
  await expect(viewElement).toHaveAttribute("sandbox", "allow-scripts");
  await expect(page.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
  await expect(page.locator("code")).toContainText("https://landing.example.test/mcp");
  expect(await page.evaluate(() => self.origin)).toBe("https://landing.example.test");
  expect(await viewElement.evaluate(() => self.origin)).toBe("null");
  expect(await app.locator("body").evaluate(() => self.origin)).toBe("null");
  await expect(app.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute("content", /frame-src 'none'/);
  await expect(app.getByRole("heading")).toHaveText("Traffic over time");
  await app.getByRole("button", {name:"Data",exact:true}).click();
  await expect(app.locator("tbody tr")).toHaveCount(7);
  await page.getByRole("button", {name:"Cursor",exact:true}).click();
  await expect(page.locator("code")).toContainText("mcpServers");
  await expect(page.getByRole("button", {name:"Copy configuration"})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("the app adopts the host's visual tokens and safe area without resetting the selected metric", async ({page, app}) => {
  await app.getByLabel("Metric").selectOption("bounce_rate");
  await page.evaluate(() => document.querySelector("iframe").contentWindow.postMessage({
    jsonrpc: "2.0", method: "ui/notifications/host-context-changed",
    params: {safeAreaInsets:{top:0,right:0,bottom:0,left:36}, styles:{variables:{
      "--color-text-info":"#086c62", "--border-radius-sm":"13px", "--font-heading-md-size":"27px",
    }}},
  }, "*"));
  await expect(app.locator("h2")).toHaveCSS("font-size", "27px");
  await expect(app.getByLabel("Metric")).toHaveCSS("border-top-right-radius", "13px");
  await expect(app.locator(".mark i").first()).toHaveCSS("background-color","rgb(8, 108, 98)");
  await expect(app.locator("#plausible-app")).toHaveCSS("padding-left", "36px");
  await expect(app.getByLabel("Metric")).toHaveValue("bounce_rate");
});

test("a selected day follows the user into chat without hover changing the question", async ({page, app}) => {
  await page.getByRole("combobox", {name:"Tool", exact:true}).selectOption("compare_periods");
  await app.getByRole("button", {name:"Daily trend"}).click();
  const plot = app.getByRole("slider"), selection = page.locator("#selection"), message = page.locator("#message");
  await hoverTimeAxis(plot, 0);
  await expect(selection).toHaveText("");
  await plot.press("Home");
  await app.getByLabel("Metric").selectOption("bounce_rate");
  await expect(selection).toHaveText('{"plausibleDay":null}');
  await plot.press("Home");
  for (let i = 1; i < 5; i++) await plot.press("ArrowRight");
  const chosen = {day:5, site_id:"example.com", metric:"bounce_rate", dimension:"event:page",
    baseline:"2026-09-21", comparison:"2026-10-05", page:"/docs*", goal:"Signup",
    property_filters:[{property:"plan", values:["trial"]}]};
  await expect(selection).toHaveText(JSON.stringify({plausibleDay:chosen}));
  await hoverTimeAxis(plot, 1);
  await expect(message).toHaveText("");
  await app.getByRole("button", {name:"Which pages drove this drop?"}).click();
  await expect(message).toHaveText('Which pages drove this drop? Compare bounce_rate by page for "example.com" on 2026-09-21 (baseline) and 2026-10-05 (comparison), Day 5. Keep these filters: {"page":"/docs*","goal":"Signup","property_filters":[{"property":"plan","values":["trial"]}]}.');
  await plot.press("Home");
  await plot.press("ArrowRight");
  await expect(selection).toHaveText('{"plausibleDay":null}');
  await expect(app.locator(".day-action button")).toBeHidden();
});

for (const host of ["no-chat", "decline"]) {
  test("a " + host + " host lets the user take the exact question to chat", async ({page}) => {
    await page.goto(preview + "?" + host);
    await page.getByRole("combobox", {name:"Tool", exact:true}).selectOption("compare_periods");
    const app = view(page);
    await app.getByRole("button", {name:"Daily trend"}).click();
    const plot = app.getByRole("slider");
    await hoverTimeAxis(plot, 0);
    const x = await plot.locator("line").first().evaluate(line => line.x1.baseVal.value);
    await plot.click({position:{x,y:26}});
    await app.locator(".day-action button").click();
    const question = app.getByRole("textbox", {name:"Question to paste in chat"});
    await expect(question).toBeFocused();
    await expect(question).toHaveValue(/visitors by page for "example.com" on 2026-09-17 .*2026-10-01/);
    await expect(page.locator("#message")).toHaveText("");
  });
}

const screens = new URL("../coverage/ui-review/screens/", import.meta.url);
const toolNames = ["get_timeseries", "get_breakdown", "get_conversions", "compare_periods", "send_feedback"];
const textSelectors = ["h2", ".identity", ".context", ".value", ".detail", ".note", ".state-message", ".plot text",
  ".metric-picker select", ".modes button", ".rank-label", ".rank strong", ".pair > div", "th", "td"];

const rgb = (css) => css.match(/[\d.]+/g).slice(0, 3).map(Number);
const luminance = (color) => {
  const [r, g, b] = color.map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

async function dominantColor(decoder, png) {
  return decoder.evaluate(async (data) => {
    const image = new Image();
    image.src = "data:image/png;base64," + data;
    await image.decode();
    const canvas = Object.assign(document.createElement("canvas"), { width: image.width, height: image.height });
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    const counts = new Map();
    for (let i = 0; i < pixels.length; i += 4) {
      const key = pixels[i] + "," + pixels[i + 1] + "," + pixels[i + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1])[0][0].split(",").map(Number);
  }, png.toString("base64"));
}

async function expectReadableText(decoder, app, label) {
  for (const selector of textSelectors) {
    const element = app.locator(selector).filter({ visible: true }).first();
    if (!(await element.count()) || await element.evaluate((node) => node.disabled)) continue;
    const surface = await dominantColor(decoder, await element.screenshot());
    const text = rgb(await element.evaluate((node) => getComputedStyle(node)[node instanceof SVGElement ? "fill" : "color"]));
    expect(contrast(text, surface), `${label}: ${selector} rgb(${text}) on rgb(${surface})`).toBeGreaterThanOrEqual(4.5);
  }
}

async function expectHostBackground(page, decoder, frame, surface, path, exact) {
  const host = rgb(await surface.evaluate((element) => getComputedStyle(element).backgroundColor));
  const painted = await dominantColor(decoder, await frame.screenshot({ path }));
  const message = `painted background rgb(${painted}) does not match the host surface rgb(${host})`;
  if (exact) for (const [i, channel] of painted.entries()) expect(Math.abs(channel - host[i]), message).toBeLessThanOrEqual(3);
  else expect(Math.abs(luminance(painted) - luminance(host)), message).toBeLessThan(0.1);
}

for (const colorScheme of ["light", "dark"]) {
  test.describe(`on a ${colorScheme} device`, () => {
    test.use({ colorScheme });
    const opposite = colorScheme === "light" ? "dark" : "light";
    for (const [theme, host] of [["light", ""], ["dark", ""], [opposite, "no-host-styles"], ["light", "plain-proxy"], ["dark", "plain-proxy"]]) {
      test(`every tool is readable on a ${theme} host${host && " with " + host}`, async ({ page, browserName }) => {
        await page.goto(preview + (host && "?" + host));
        await page.getByLabel("Theme").selectOption(theme);
        const app = view(page);
        const decoder = await page.context().newPage();
        for (const name of toolNames) {
          await page.getByRole("combobox", { name: "Tool", exact: true }).selectOption(name);
          await expect(app.locator("h2")).not.toHaveText("Analytics");
          const file = [browserName, colorScheme + "-device", theme + "-host", host || "default", name].join("-") + ".png";
          await expectHostBackground(page, decoder, page.locator('iframe[title="Plausible Analytics"]'), page.locator("body"),
            new URL(file, screens).pathname, host !== "plain-proxy");
          await expectReadableText(decoder, app, name);
          const data = app.getByRole("button", { name: "Data", exact: true });
          if (await data.count()) {
            await data.click();
            await expectReadableText(decoder, app, name + " data");
          }
        }
        await decoder.close();
      });
    }

    test("the landing page chart is readable", async ({ page, browserName }) => {
      const { landingHtml, landingSecurityPolicy } = await import("../dist/landing.js");
      await page.route("https://landing.example.test/", (route) => route.fulfill({
        body: landingHtml("https://landing.example.test/mcp"), headers: { "content-type": "text/html", "content-security-policy": landingSecurityPolicy },
      }));
      await page.goto("https://landing.example.test/");
      const app = page.frameLocator("iframe").frameLocator('iframe[title="Analytics result"]');
      await expect(app.locator("h2")).toHaveText("Traffic over time");
      const decoder = await page.context().newPage();
      await expectHostBackground(page, decoder, page.locator(".frame iframe"), page.locator(".frame"),
        new URL(`${browserName}-${colorScheme}-device-landing.png`, screens).pathname, true);
      await expectReadableText(decoder, app, "landing");
      await decoder.close();
    });
  });
}
