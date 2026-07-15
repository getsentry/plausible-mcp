import { beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  captureException: vi.fn(),
  count: vi.fn(),
}));

vi.mock("@sentry/cloudflare", () => ({
  captureException: sentry.captureException,
  metrics: { count: sentry.count },
}));

const { captureException, count } = sentry;

import { PlausibleApiError } from "../src/plausible.js";
import { reportToolError, UserFacingError } from "../src/errors.js";

const toolName = "get_timeseries";

describe("reportToolError", () => {
  beforeEach(() => {
    captureException.mockReset();
    count.mockReset();
  });

  it("records user-facing failures without creating an exception issue", () => {
    const error = new UserFacingError("site_id is required");

    expect(reportToolError(error, toolName)).toBe("site_id is required");
    expect(count).toHaveBeenCalledWith("mcp.tool.error", 1, {
      attributes: {
        "mcp.tool.name": toolName,
        "error.kind": "user_input",
      },
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it("records expected Plausible 4xx responses without creating an exception issue", () => {
    const error = new PlausibleApiError(401, "Invalid API key or site ID");

    expect(reportToolError(error, toolName)).toBe(
      "Plausible rejected the API key or site_id (401)",
    );
    expect(count).toHaveBeenCalledWith("mcp.tool.error", 1, {
      attributes: {
        "mcp.tool.name": toolName,
        "error.kind": "plausible_api",
        "http.response.status_code": 401,
      },
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it("captures Plausible 5xx responses while recording the tool failure", () => {
    const error = new PlausibleApiError(503, "Unavailable");

    expect(reportToolError(error, toolName)).toBe("Plausible API returned 503");
    expect(count).toHaveBeenCalledOnce();
    expect(captureException).toHaveBeenCalledWith(error);
  });

  it("captures unexpected failures and returns a safe message", () => {
    const error = new Error("secret implementation detail");

    expect(reportToolError(error, toolName)).toBe("An unexpected error occurred");
    expect(count).toHaveBeenCalledWith("mcp.tool.error", 1, {
      attributes: {
        "mcp.tool.name": toolName,
        "error.kind": "unexpected",
      },
    });
    expect(captureException).toHaveBeenCalledWith(error);
  });
});
