import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

const sentry = vi.hoisted(() => ({
  captureException: vi.fn(),
  count: vi.fn(),
  setAttribute: vi.fn(),
}));

vi.mock("@sentry/cloudflare", () => ({
  captureException: sentry.captureException,
  metrics: { count: sentry.count },
  getActiveSpan: () => ({ setAttribute: sentry.setAttribute }),
}));

const { captureException, count, setAttribute } = sentry;

import { PlausibleApiError, PlausibleUnreachableError } from "../src/plausible.js";
import { reportToolError, toolErrorResult, UserFacingError } from "../src/errors.js";

const toolName = "get_timeseries";

describe("reportToolError", () => {
  beforeEach(() => {
    captureException.mockReset();
    count.mockReset();
    setAttribute.mockReset();
  });

  it.each([
    [new UserFacingError("pick one goal"), "invalid_input"],
    [new PlausibleApiError(401, "Invalid API key"), "unauthorized"],
    [new PlausibleApiError(429, "Too many requests"), "rate_limited"],
    [new PlausibleApiError(503, "Unavailable"), "upstream_unavailable"],
    [new PlausibleApiError(400, "Invalid filter"), "invalid_query"],
    [new PlausibleUnreachableError(new Error("socket hang up")), "upstream_unavailable"],
    [new Error("boom"), "internal"],
  ])("records only the error code on the tool span for %s", (error, code) => {
    reportToolError(error, toolName);

    expect(setAttribute.mock.calls).toEqual([["app.tool.error.code", code]]);
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

  // Every status Plausible can answer with maps to exactly one code. Regression (9b013ad):
  // 402 is an account problem, not a bad query.
  it("classifies every 4xx and 5xx status by the documented rules", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 400, max: 599 }),
        fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: undefined }),
        fc.option(fc.nat(86_400), { nil: undefined }),
        (status, detail, retryAfter) => {
          captureException.mockReset();
          const body = detail === undefined ? "<html>error</html>" : JSON.stringify({ error: detail });

          const info = reportToolError(new PlausibleApiError(status, body, retryAfter), toolName);

          const expected =
            status === 401 || status === 402 || status === 403 ? "unauthorized"
            : status === 429 ? "rate_limited"
            : status >= 500 ? "upstream_unavailable"
            : "invalid_query";
          expect(info.code).toBe(expected);
          expect(info.retryable).toBe(status === 429 || status >= 500);
          expect(captureException).toHaveBeenCalledTimes(status >= 500 ? 1 : 0);
          expect(info.message).toContain(String(status));
          if (detail !== undefined) expect(info.message.endsWith(`: ${detail}`)).toBe(true);
          else expect(info.message).not.toContain(":");
          if (info.retryable && retryAfter !== undefined) expect(info.retry_after_seconds).toBe(retryAfter);
          else expect(info).not.toHaveProperty("retry_after_seconds");
        }
      )
    );
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

  it("classifies an unreachable Plausible API as retryable upstream_unavailable", () => {
    const error = new PlausibleUnreachableError(new TypeError("fetch failed"));

    expect(reportToolError(error, toolName)).toEqual({
      code: "upstream_unavailable",
      message: "Could not reach the Plausible API",
      retryable: true,
    });
    expect(count).toHaveBeenCalledWith("mcp.tool.error", 1, {
      attributes: {
        "mcp.tool.name": toolName,
        "error.kind": "plausible_unreachable",
      },
    });
    expect(captureException).toHaveBeenCalledWith(error);
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

});

describe("toolErrorResult", () => {
  beforeEach(() => {
    captureException.mockReset();
    count.mockReset();
  });

  const anyToolError = fc.oneof(
    fc.string({ minLength: 1 }).map((message) => new UserFacingError(message)),
    fc
      .tuple(fc.integer({ min: 400, max: 599 }), fc.option(fc.nat(600), { nil: undefined }))
      .map(([status, wait]) => new PlausibleApiError(status, "", wait)),
    fc.constant(new PlausibleUnreachableError(new TypeError("fetch failed"))),
    fc.string().map((message) => new Error(message))
  );

  it("returns the readable message first and the same error as JSON second, for any error", () => {
    fc.assert(
      fc.property(anyToolError, fc.boolean(), (error, offerFeedback) => {
        const info = reportToolError(error, toolName);
        const result = toolErrorResult(error, toolName, offerFeedback);

        expect(result.isError).toBe(true);
        expect(result.content).toHaveLength(2);
        expect(JSON.parse(result.content[1].text)).toEqual({ error: info });
        const text = result.content[0].text;
        expect(text.startsWith(`Error: ${info.message}`)).toBe(true);
        expect(text.includes("send_feedback")).toBe(
          offerFeedback && (info.code === "invalid_query" || info.code === "internal")
        );
        expect(/retry/i.test(text.slice(`Error: ${info.message}`.length))).toBe(info.retryable);
      })
    );
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

  it("points a rejected query at send_feedback when the tool is offered", () => {
    const result = toolErrorResult(new PlausibleApiError(400, ""), toolName, true);

    expect(result.content[0].text).toBe(
      "Error: Plausible API returned 400\nIf this message doesn't tell you how to fix the call, report it with send_feedback.",
    );
    expect(JSON.parse(result.content[1].text).error.message).toBe("Plausible API returned 400");
  });

});
