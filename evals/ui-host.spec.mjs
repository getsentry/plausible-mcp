import { expect, hoverTimeAxis, preview, test, view } from "./ui-fixtures.mjs";

test("landing page renders the shipped app and switches installation instructions", async ({
  page,
}) => {
  const { landingHtml, landingSecurityPolicy } = await import("../dist/landing.js");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://landing.example.test/", (route) =>
    route.fulfill({
      body: landingHtml("https://landing.example.test/mcp"),
      headers: { "content-type": "text/html", "content-security-policy": landingSecurityPolicy },
    }),
  );
  await page.setViewportSize({ width: 375, height: 812 });
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
  await expect(app.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
    "content",
    /frame-src 'none'/,
  );
  await expect(app.getByRole("heading")).toHaveText("Traffic over time");
  await app.getByRole("button", { name: "Data", exact: true }).click();
  await expect(app.locator("tbody tr")).toHaveCount(7);
  await page.getByRole("button", { name: "Cursor", exact: true }).click();
  await expect(page.locator("code")).toContainText("mcpServers");
  await expect(page.getByRole("button", { name: "Copy configuration" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("the app adopts the host's visual tokens and safe area without resetting the selected metric", async ({
  page,
  app,
}) => {
  await app.getByLabel("Metric").selectOption("bounce_rate");
  await page.evaluate(() =>
    document.querySelector("iframe").contentWindow.postMessage(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: {
          safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 36 },
          styles: {
            variables: {
              "--color-text-info": "#086c62",
              "--border-radius-sm": "13px",
              "--font-heading-md-size": "27px",
            },
          },
        },
      },
      "*",
    ),
  );
  await expect(app.locator("h2")).toHaveCSS("font-size", "27px");
  await expect(app.getByLabel("Metric")).toHaveCSS("border-top-right-radius", "13px");
  await expect(app.locator(".mark i").first()).toHaveCSS("background-color", "rgb(8, 108, 98)");
  await expect(app.locator("#plausible-app")).toHaveCSS("padding-left", "36px");
  await expect(app.getByLabel("Metric")).toHaveValue("bounce_rate");
});

test("a selected day follows the user into chat without hover changing the question", async ({
  page,
  app,
}) => {
  await page.getByRole("combobox", { name: "Tool", exact: true }).selectOption("compare_periods");
  await app.getByRole("button", { name: "Daily trend" }).click();
  const plot = app.getByRole("slider"),
    selection = page.locator("#selection"),
    message = page.locator("#message");
  await hoverTimeAxis(plot, 0);
  await expect(selection).toHaveText("");
  await plot.press("Home");
  await app.getByLabel("Metric").selectOption("bounce_rate");
  await expect(selection).toHaveText('{"plausibleDay":null}');
  await plot.press("Home");
  for (let i = 1; i < 5; i++) await plot.press("ArrowRight");
  const chosen = {
    day: 5,
    site_id: "example.com",
    metric: "bounce_rate",
    dimension: "event:page",
    baseline: "2026-09-21",
    comparison: "2026-10-05",
    page: "/docs*",
    goal: "Signup",
    property_filters: [{ property: "plan", values: ["trial"] }],
  };
  await expect(selection).toHaveText(JSON.stringify({ plausibleDay: chosen }));
  await hoverTimeAxis(plot, 1);
  await expect(message).toHaveText("");
  await app.getByRole("button", { name: "Which pages drove this drop?" }).click();
  await expect(message).toHaveText(
    'Which pages drove this drop? Compare bounce_rate by page for "example.com" on 2026-09-21 (baseline) and 2026-10-05 (comparison), Day 5. Keep these filters: {"page":"/docs*","goal":"Signup","property_filters":[{"property":"plan","values":["trial"]}]}.',
  );
  await plot.press("Home");
  await plot.press("ArrowRight");
  await expect(selection).toHaveText('{"plausibleDay":null}');
  await expect(app.locator(".day-action button")).toBeHidden();
});

for (const host of ["no-chat", "decline"]) {
  test("a " + host + " host lets the user take the exact question to chat", async ({ page }) => {
    await page.goto(preview + "?" + host);
    await page.getByRole("combobox", { name: "Tool", exact: true }).selectOption("compare_periods");
    const app = view(page);
    await app.getByRole("button", { name: "Daily trend" }).click();
    const plot = app.getByRole("slider");
    await hoverTimeAxis(plot, 0);
    const x = await plot
      .locator("line")
      .first()
      .evaluate((line) => line.x1.baseVal.value);
    await plot.click({ position: { x, y: 26 } });
    await app.locator(".day-action button").click();
    const question = app.getByRole("textbox", { name: "Question to paste in chat" });
    await expect(question).toBeFocused();
    await expect(question).toHaveValue(
      /visitors by page for "example.com" on 2026-09-17 .*2026-10-01/,
    );
    await expect(page.locator("#message")).toHaveText("");
  });
}
