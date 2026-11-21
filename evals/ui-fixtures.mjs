// Shared by the MCP Apps browser checks: the preview page, the app fixture, and the
// pixel and contrast measurements behind the readability checks.
import { test as base, expect } from "@playwright/test";

export const preview = new URL("../coverage/ui-review/index.html", import.meta.url).href;
export const view = (page) =>
  page
    .frameLocator('iframe[title="Plausible Analytics"]')
    .frameLocator('iframe[title="Analytics result"]');
export const test = base.extend({
  // Every test fails on a page error or console error, including the tests that drive the
  // page without the app fixture.
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await use(page);
    expect(errors).toEqual([]);
  },
  app: async ({ page }, use) => {
    const network = [];
    page.on("request", (request) => {
      if (/^https?:/.test(request.url())) network.push(request.url());
    });
    await page.goto(preview);
    const app = view(page);
    await expect(app.getByRole("heading", { name: "Traffic over time" })).toBeVisible();
    await use(app);
    expect(network).toEqual([]);
  },
});

export async function hoverTimeAxis(plot, fraction) {
  const x = await plot
    .locator("line")
    .first()
    .evaluate((line, fraction) => {
      const left = line.x1.baseVal.value;
      return left + (line.x2.baseVal.value - left) * fraction;
    }, fraction);
  await plot.hover({ position: { x, y: 70 } });
}

export const screens = new URL("../coverage/ui-review/screens/", import.meta.url);
export const toolNames = [
  "get_timeseries",
  "get_breakdown",
  "get_conversions",
  "compare_periods",
  "send_feedback",
];
export const textSelectors = [
  "h2",
  ".identity",
  ".context",
  ".value",
  ".detail",
  ".note",
  ".state-message",
  ".plot text",
  ".metric-picker select",
  ".modes button",
  ".rank-label",
  ".rank strong",
  ".pair > div",
  "th",
  "td",
];

const rgb = (css) =>
  css
    .match(/[\d.]+/g)
    .slice(0, 3)
    .map(Number);
const luminance = (color) => {
  const [r, g, b] = color
    .map((v) => v / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

function dominantColor(decoder, png) {
  return decoder.evaluate(async (data) => {
    const image = new Image();
    image.src = "data:image/png;base64," + data;
    await image.decode();
    const canvas = Object.assign(document.createElement("canvas"), {
      width: image.width,
      height: image.height,
    });
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    const counts = new Map();
    for (let i = 0; i < pixels.length; i += 4) {
      const key = pixels[i] + "," + pixels[i + 1] + "," + pixels[i + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts]
      .sort((a, b) => b[1] - a[1])[0][0]
      .split(",")
      .map(Number);
  }, png.toString("base64"));
}

export async function expectReadableText(decoder, app, label) {
  for (const selector of textSelectors) {
    const element = app.locator(selector).filter({ visible: true }).first();
    if (!(await element.count()) || (await element.evaluate((node) => node.disabled))) continue;
    const surface = await dominantColor(decoder, await element.screenshot());
    const text = rgb(
      await element.evaluate(
        (node) => getComputedStyle(node)[node instanceof SVGElement ? "fill" : "color"],
      ),
    );
    expect(
      contrast(text, surface),
      `${label}: ${selector} rgb(${text}) on rgb(${surface})`,
    ).toBeGreaterThanOrEqual(4.5);
  }
}

async function hostAndPainted(decoder, frame, surface, path) {
  const host = rgb(await surface.evaluate((element) => getComputedStyle(element).backgroundColor));
  const painted = await dominantColor(decoder, await frame.screenshot({ path }));
  return { host, painted };
}

/** The frame paints the host surface's color, within anti-aliasing (3 per channel). */
export async function expectHostBackground(decoder, frame, surface, path) {
  const { host, painted } = await hostAndPainted(decoder, frame, surface, path);
  expect(
    painted.map((channel, i) => Math.abs(channel - host[i]) <= 3),
    `painted background rgb(${painted}) does not match the host surface rgb(${host})`,
  ).toEqual([true, true, true]);
}

/**
 * The frame paints a color as light as the host surface. For a sandbox proxy that sets no
 * color scheme, whose canvas can differ a little from the host surface.
 */
export async function expectHostLightness(decoder, frame, surface, path) {
  const { host, painted } = await hostAndPainted(decoder, frame, surface, path);
  expect(
    Math.abs(luminance(painted) - luminance(host)),
    `painted background rgb(${painted}) is not as light as the host surface rgb(${host})`,
  ).toBeLessThan(0.1);
}

export { expect };
