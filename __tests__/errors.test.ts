import { beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import * as Sentry from "@sentry/cloudflare";
import { PlausibleApiError, PlausibleUnreachableError } from "../src/plausible.js";
import { reportToolError, toolErrorResult, UserFacingError } from "../src/errors.js";
import { z } from "zod";
import { captureSentry } from "./harness.js";

const errorEvent = z.object({
  exception: z.object({ values: z.array(z.object({ type: z.string(), value: z.string() })) }),
});

let sentry: ReturnType<typeof captureSentry>;
beforeAll(() => {
  sentry = captureSentry();
});

/** Report the error inside a tool span and return what Sentry received for it. */
async function report(cause: Error) {
  sentry.clear();
  const info = Sentry.startSpan({ name: "tools/call get_timeseries" }, () =>
    reportToolError(cause, toolName),
  );
  await sentry.flush();
  return {
    info,
    span: sentry.spans[0],
    exceptions: sentry.items("event", errorEvent).map((event) => event.exception.values[0]),
    metrics: sentry.metrics(),
  };
}

const toolName = "get_timeseries";

/** The documented code for each Plausible status. */
function expectedCode(status: number): string {
  if (status === 401 || status === 402 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  return status >= 500 ? "upstream_unavailable" : "invalid_query";
}

describe("reportToolError", () => {
  it.each([
    [new UserFacingError("pick one goal"), "invalid_input"],
    [new PlausibleApiError(401, "Invalid API key"), "unauthorized"],
    [new PlausibleApiError(429, "Too many requests"), "rate_limited"],
    [new PlausibleApiError(503, "Unavailable"), "upstream_unavailable"],
    [new PlausibleApiError(400, "Invalid filter"), "invalid_query"],
    [new PlausibleUnreachableError(new Error("socket hang up")), "upstream_unavailable"],
    [new Error("boom"), "internal"],
  ])("records only the error code on the tool span for %s", async (error, code) => {
    const { span } = await report(error);

    expect(span["app.tool.error.code"]).toBe(code);
    expect(Object.keys(span).filter((key) => !key.startsWith("sentry."))).toEqual([
      "app.tool.error.code",
    ]);
  });

  it("records user-facing failures without creating an exception issue", async () => {
    const { info, metrics, exceptions } = await report(new UserFacingError("site_id is required"));

    expect(info).toEqual({
      code: "invalid_input",
      message: "site_id is required",
      retryable: false,
    });
    expect(metrics).toEqual([
      {
        name: "mcp.tool.error",
        value: 1,
        attributes: { "mcp.tool.name": toolName, "error.kind": "user_input" },
      },
    ]);
    expect(exceptions).toEqual([]);
  });

  it("records expected Plausible 4xx responses without creating an exception issue", async () => {
    const { info, metrics, exceptions } = await report(
      new PlausibleApiError(401, "Invalid API key or site ID"),
    );

    expect(info).toEqual({
      code: "unauthorized",
      message: "Plausible rejected the API key or site_id (401)",
      access_reason: "key_or_site",
      retryable: false,
    });
    expect(metrics).toEqual([
      {
        name: "mcp.tool.error",
        value: 1,
        attributes: {
          "mcp.tool.name": toolName,
          "error.kind": "plausible_api",
          "http.response.status_code": 401,
        },
      },
    ]);
    expect(exceptions).toEqual([]);
  });

  it("captures Plausible 5xx responses while recording the tool failure", async () => {
    const { info, metrics, exceptions } = await report(new PlausibleApiError(503, "Unavailable"));

    expect(info).toEqual({
      code: "upstream_unavailable",
      message: "Plausible API returned 503",
      retryable: true,
    });
    expect(metrics).toHaveLength(1);
    expect(exceptions).toMatchObject([
      { type: "PlausibleApiError", value: "Plausible API error 503" },
    ]);
  });

  it("returns the Plausible error message to the caller", async () => {
    const { info, exceptions } = await report(
      new PlausibleApiError(400, JSON.stringify({ error: 'Invalid metric "pagevies"' })),
    );

    expect(info).toEqual({
      code: "invalid_query",
      message: 'Plausible API returned 400: Invalid metric "pagevies"',
      retryable: false,
    });
    expect(exceptions).toEqual([]);
  });

  // Every status Plausible can answer with maps to exactly one code. Regression (9b013ad):
  // 402 is an account problem, not a bad query. Each status is checked, not sampled.
  const statuses = Array.from({ length: 200 }, (_, i) => 400 + i);
  it.each(statuses)("classifies status %i by the documented rules", async (status) => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: undefined }),
        fc.option(fc.nat(86_400), { nil: undefined }),
        async (detail, retryAfter) => {
          const body =
            detail === undefined ? "<html>error</html>" : JSON.stringify({ error: detail });

          const { info, exceptions } = await report(
            new PlausibleApiError(status, body, retryAfter),
          );

          const retryable = status === 429 || status >= 500;
          expect(info.code).toBe(expectedCode(status));
          expect(info.retryable).toBe(retryable);
          expect(exceptions).toHaveLength(status >= 500 ? 1 : 0);
          expect(info.message).toContain(String(status));
          // The summary has no ": ", so everything after the first one is Plausible's message.
          expect(info.message.split(": ").slice(1).join(": ")).toBe(detail ?? "");
          const wait = retryable ? retryAfter : undefined;
          expect(info.retry_after_seconds).toBe(wait);
          expect("retry_after_seconds" in info).toBe(wait !== undefined);
        },
      ),
      { numRuns: 5 },
    );
  });

  it("gives the caller a 5xx detail while nothing sent to Sentry contains it", async () => {
    const { info, exceptions } = await report(
      new PlausibleApiError(503, JSON.stringify({ error: "failed filter customer@example.com" })),
    );

    expect(info.message).toBe("Plausible API returned 503: failed filter customer@example.com");
    expect(exceptions).toMatchObject([{ value: "Plausible API error 503" }]);
    expect(JSON.stringify(sentry.envelopes)).not.toContain("customer@example.com");
  });

  it("classifies an unreachable Plausible API as retryable upstream_unavailable", async () => {
    const { info, metrics, exceptions } = await report(
      new PlausibleUnreachableError(new TypeError("fetch failed")),
    );

    expect(info).toEqual({
      code: "upstream_unavailable",
      message: "Could not reach the Plausible API",
      retryable: true,
    });
    expect(metrics).toMatchObject([{ attributes: { "error.kind": "plausible_unreachable" } }]);
    expect(exceptions).toMatchObject([{ type: "PlausibleUnreachableError" }]);
  });

  it("captures unexpected failures and returns a safe message", async () => {
    const { info, metrics, exceptions } = await report(new Error("secret implementation detail"));

    expect(info).toEqual({
      code: "internal",
      message: "An unexpected error occurred",
      retryable: false,
    });
    expect(metrics).toMatchObject([{ attributes: { "error.kind": "unexpected" } }]);
    // The exception keeps its detail for debugging; only the caller's message is generic.
    expect(exceptions).toMatchObject([{ value: "secret implementation detail" }]);
  });
});

describe("toolErrorResult", () => {
  const anyToolError = fc.oneof(
    fc.string({ minLength: 1 }).map((message) => new UserFacingError(message)),
    fc
      .tuple(fc.integer({ min: 400, max: 599 }), fc.option(fc.nat(600), { nil: undefined }))
      .map(([status, wait]) => new PlausibleApiError(status, "", wait)),
    fc.constant(new PlausibleUnreachableError(new TypeError("fetch failed"))),
    fc.string().map((message) => new Error(message)),
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
          offerFeedback && (info.code === "invalid_query" || info.code === "internal"),
        );
        expect(/retry/i.test(text.slice(`Error: ${info.message}`.length))).toBe(info.retryable);
      }),
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
