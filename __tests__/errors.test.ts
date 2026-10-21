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
import { reportToolError, toolErrorResult, UserFacingError } from "../src/errors.js";

const toolName = "get_timeseries";

describe("reportToolError", () => {
  beforeEach(() => {
    captureException.mockReset();
    count.mockReset();
  });

  it("records user-facing failures without creating an exception issue", () => {
    const error = new UserFacingError("site_id is required");

    expect(reportToolError(error, toolName)).toEqual({
      code: "invalid_input",
      message: "site_id is required",
      retryable: false,
    });
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

    expect(reportToolError(error, toolName)).toEqual({
      code: "unauthorized",
      message: "Plausible rejected the API key or site_id (401)",
      retryable: false,
    });
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

    expect(reportToolError(error, toolName)).toEqual({
      code: "upstream_unavailable",
      message: "Plausible API returned 503",
      retryable: true,
    });
    expect(count).toHaveBeenCalledOnce();
    expect(captureException).toHaveBeenCalledWith(error);
  });

  it("returns the Plausible error message to the caller", () => {
    const error = new PlausibleApiError(
      400,
      JSON.stringify({ error: "Invalid metric \"pagevies\"" })
    );

    expect(reportToolError(error, toolName)).toEqual({
      code: "invalid_query",
      message: 'Plausible API returned 400: Invalid metric "pagevies"',
      retryable: false,
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it("appends the Plausible error message to the 401 guidance", () => {
    const error = new PlausibleApiError(401, JSON.stringify({ error: "site does not exist" }));

    expect(reportToolError(error, toolName).message).toBe(
      "Plausible rejected the API key or site_id (401): site does not exist",
    );
  });

  it("falls back to the status-only message for a non-JSON body", () => {
    const error = new PlausibleApiError(502, "<html>Bad Gateway</html>");

    expect(reportToolError(error, toolName).message).toBe("Plausible API returned 502");
  });

  it("gives the caller a 5xx detail while the captured exception stays status-only", () => {
    const error = new PlausibleApiError(
      503,
      JSON.stringify({ error: "failed filter customer@example.com" })
    );

    expect(reportToolError(error, toolName).message).toBe(
      "Plausible API returned 503: failed filter customer@example.com",
    );
    expect(captureException).toHaveBeenCalledWith(error);
    const captured = captureException.mock.calls[0][0] as Error;
    expect(captured.message).toBe("Plausible API error 503");
    expect(JSON.stringify(captured)).not.toContain("customer@example.com");
  });

  it("captures unexpected failures and returns a safe message", () => {
    const error = new Error("secret implementation detail");

    expect(reportToolError(error, toolName)).toEqual({
      code: "internal",
      message: "An unexpected error occurred",
      retryable: false,
    });
    expect(count).toHaveBeenCalledWith("mcp.tool.error", 1, {
      attributes: {
        "mcp.tool.name": toolName,
        "error.kind": "unexpected",
      },
    });
    expect(captureException).toHaveBeenCalledWith(error);
  });

  it("classifies 403 as unauthorized", () => {
    const error = new PlausibleApiError(403, JSON.stringify({ error: "forbidden" }));

    expect(reportToolError(error, toolName)).toEqual({
      code: "unauthorized",
      message: "Plausible API returned 403: forbidden",
      retryable: false,
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it("classifies 429 as retryable and carries the wait time when known", () => {
    const error = new PlausibleApiError(429, "", 30);

    expect(reportToolError(error, toolName)).toEqual({
      code: "rate_limited",
      message: "Plausible rate limit exceeded (429)",
      retryable: true,
      retry_after_seconds: 30,
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it("carries the wait time on a 5xx upstream_unavailable", () => {
    expect(reportToolError(new PlausibleApiError(503, "", 7), toolName)).toMatchObject({
      code: "upstream_unavailable",
      retryable: true,
      retry_after_seconds: 7,
    });
  });

  it("omits retry_after_seconds on 429 without a Retry-After header", () => {
    const info = reportToolError(new PlausibleApiError(429, ""), toolName);

    expect(info.code).toBe("rate_limited");
    expect(info.retryable).toBe(true);
    expect(info).not.toHaveProperty("retry_after_seconds");
  });
});

describe("toolErrorResult", () => {
  beforeEach(() => {
    captureException.mockReset();
    count.mockReset();
  });

  it("returns an isError result with the error as JSON in a second text block", () => {
    const result = toolErrorResult(new UserFacingError("site_id is required"), toolName);

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({ type: "text", text: "Error: site_id is required" });
    expect(JSON.parse(result.content[1].text)).toEqual({
      error: { code: "invalid_input", message: "site_id is required", retryable: false },
    });
  });

  it("carries no structuredContent", () => {
    const result = toolErrorResult(new UserFacingError("site_id is required"), toolName);

    expect(result).not.toHaveProperty("structuredContent");
  });

  it("appends the wait time for a rate limit", () => {
    const result = toolErrorResult(new PlausibleApiError(429, "", 12), toolName);

    expect(result.content[0].text).toBe(
      "Error: Plausible rate limit exceeded (429) Retry after 12 seconds.",
    );
    expect(JSON.parse(result.content[1].text).error.retry_after_seconds).toBe(12);
  });

  it("puts the wait time of a 503 in the JSON error block", () => {
    const result = toolErrorResult(new PlausibleApiError(503, "", 9), toolName);

    expect(result.content[0].text).toBe(
      "Error: Plausible API returned 503 Retry after 9 seconds.",
    );
    expect(JSON.parse(result.content[1].text).error).toMatchObject({
      code: "upstream_unavailable",
      retry_after_seconds: 9,
    });
  });

  it("flags a retryable error without a wait time as temporary", () => {
    const result = toolErrorResult(new PlausibleApiError(503, ""), toolName);

    expect(result.content[0].text).toBe(
      "Error: Plausible API returned 503 This error is temporary; retry later.",
    );
  });

  it("adds no retry hint to a non-retryable error", () => {
    const result = toolErrorResult(new PlausibleApiError(400, ""), toolName);

    expect(result.content[0].text).toBe("Error: Plausible API returned 400");
  });
});
