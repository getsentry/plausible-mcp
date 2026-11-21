import {
  expect,
  expectHostBackground,
  expectHostLightness,
  expectReadableText,
  preview,
  screens,
  test,
  toolNames,
  view,
} from "./ui-fixtures.mjs";

for (const colorScheme of ["light", "dark"]) {
  test.describe(`on a ${colorScheme} device`, () => {
    test.use({ colorScheme });
    const opposite = colorScheme === "light" ? "dark" : "light";
    for (const [theme, host] of [
      ["light", ""],
      ["dark", ""],
      [opposite, "no-host-styles"],
      ["light", "plain-proxy"],
      ["dark", "plain-proxy"],
    ]) {
      test(`every tool is readable on a ${theme} host${host && " with " + host}`, async ({
        page,
        browserName,
      }) => {
        await page.goto(preview + (host && "?" + host));
        await page.getByLabel("Theme").selectOption(theme);
        const app = view(page);
        const decoder = await page.context().newPage();
        for (const name of toolNames) {
          await page.getByRole("combobox", { name: "Tool", exact: true }).selectOption(name);
          await expect(app.locator("h2")).not.toHaveText("Analytics");
          const file =
            [browserName, colorScheme + "-device", theme + "-host", host || "default", name].join(
              "-",
            ) + ".png";
          const expectBackground =
            host === "plain-proxy" ? expectHostLightness : expectHostBackground;
          await expectBackground(
            decoder,
            page.locator('iframe[title="Plausible Analytics"]'),
            page.locator("body"),
            new URL(file, screens).pathname,
          );
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
      await page.route("https://landing.example.test/", (route) =>
        route.fulfill({
          body: landingHtml("https://landing.example.test/mcp"),
          headers: {
            "content-type": "text/html",
            "content-security-policy": landingSecurityPolicy,
          },
        }),
      );
      await page.goto("https://landing.example.test/");
      const app = page.frameLocator("iframe").frameLocator('iframe[title="Analytics result"]');
      await expect(app.locator("h2")).toHaveText("Traffic over time");
      const decoder = await page.context().newPage();
      await expectHostBackground(
        decoder,
        page.locator(".frame iframe"),
        page.locator(".frame"),
        new URL(`${browserName}-${colorScheme}-device-landing.png`, screens).pathname,
      );
      await expectReadableText(decoder, app, "landing");
      await decoder.close();
    });
  });
}
