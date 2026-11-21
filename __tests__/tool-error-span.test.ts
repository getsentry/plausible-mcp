import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { captureSentry, connect, plausibleError, type Harness } from "./harness.js";

describe("failed tool call span, as Sentry exports it", () => {
  let sentry: ReturnType<typeof captureSentry>;
  let h: Harness;

  beforeAll(async () => {
    sentry = captureSentry();
    h = await connect();
  });
  afterAll(() => h.close());

  // Regression (f9bc0e8): only the code, never the message, which can echo caller input.
  it("keeps the error code that the client receives", async () => {
    h.reply(() => plausibleError(429, "Too many requests"));

    const result = await h.call("get_timeseries", { date_range: "7d" });
    expect(result.isError).toBe(true);

    await vi.waitFor(() =>
      expect(sentry.spans.find((data) => data["mcp.tool.name"] === "get_timeseries")).toBeDefined(),
    );
    const span = sentry.spans.find((data) => data["mcp.tool.name"] === "get_timeseries");
    expect(span).toMatchObject({
      "mcp.tool.result.is_error": true,
      "app.tool.error.code": "rate_limited",
    });
  });
});
