import * as Sentry from "@sentry/cloudflare";
import { PlausibleApiError, PlausibleUnreachableError } from "./plausible.js";

export const TOOL_NAMES = [
  "get_timeseries",
  "get_breakdown",
  "get_conversions",
  "compare_periods",
  "compare_breakdown",
  "list_sites",
  "get_site_metadata",
  "query_stats",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

export type ToolErrorCode =
  | "invalid_input"
  | "unauthorized"
  | "rate_limited"
  | "upstream_unavailable"
  | "invalid_query"
  | "internal";

/** Machine-readable failure description, returned as JSON in the second text block. */
export interface ToolErrorInfo {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  retry_after_seconds?: number;
  access_reason?: "plan_required" | "key_or_site";
}

/**
 * Preserve visibility into failed tool calls without turning expected caller errors into
 * exception issues. The MCP response remains an `isError` result; this function only decides
 * how the failure is represented in telemetry and which safe message and code the client receives.
 *
 * `cause` is whatever the tool's catch block received, so it is classified here by class.
 */
export function reportToolError(cause: unknown, toolName: ToolName): ToolErrorInfo {
  const info = classifyToolError(cause, toolName);
  // Only the code: the message can echo user input, which must not reach /mcp spans.
  Sentry.getActiveSpan()?.setAttribute("app.tool.error.code", info.code);
  return info;
}

function countToolError(toolName: ToolName, kind: string, status?: number): void {
  Sentry.metrics.count("mcp.tool.error", 1, {
    attributes: {
      "mcp.tool.name": toolName,
      "error.kind": kind,
      ...(status !== undefined && { "http.response.status_code": status }),
    },
  });
}

const PLAUSIBLE_STATUS_SUMMARIES = new Map([
  [401, "Plausible rejected the API key or site_id (401)"],
  [402, "The Plausible account behind this API key has no Stats API access (402)"],
  [429, "Plausible rate limit exceeded (429)"],
]);

function classifyPlausibleApiError(error: PlausibleApiError): ToolErrorInfo {
  const { status } = error;
  const summary = PLAUSIBLE_STATUS_SUMMARIES.get(status) ?? `Plausible API returned ${status}`;
  const message = error.detail ? `${summary}: ${error.detail}` : summary;

  if ([401, 402, 403].includes(status)) {
    return {
      code: "unauthorized",
      message,
      retryable: false,
      access_reason: status === 402 ? "plan_required" : "key_or_site",
    };
  }
  if (status !== 429 && status < 500) return { code: "invalid_query", message, retryable: false };
  return {
    code: status === 429 ? "rate_limited" : "upstream_unavailable",
    message,
    retryable: true,
    ...(error.retryAfterSeconds !== undefined && { retry_after_seconds: error.retryAfterSeconds }),
  };
}

function classifyToolError(cause: unknown, toolName: ToolName): ToolErrorInfo {
  if (cause instanceof UserFacingError) {
    countToolError(toolName, "user_input");
    return { code: "invalid_input", message: cause.message, retryable: false };
  }
  if (cause instanceof PlausibleApiError) {
    countToolError(toolName, "plausible_api", cause.status);
    if (cause.status >= 500) Sentry.captureException(cause);
    return classifyPlausibleApiError(cause);
  }
  if (cause instanceof PlausibleUnreachableError) {
    countToolError(toolName, "plausible_unreachable");
    Sentry.captureException(cause);
    return { code: "upstream_unavailable", message: cause.message, retryable: true };
  }
  countToolError(toolName, "unexpected");
  Sentry.captureException(cause);
  return { code: "internal", message: "An unexpected error occurred", retryable: false };
}

/**
 * Failed tool result: a human-readable text block followed by the machine-readable error as
 * JSON. `structuredContent` is omitted because MCP SDK v1 clients validate it against the
 * success `outputSchema` even when `isError` is true, which would turn the error into a
 * protocol failure.
 */
export function toolErrorResult(cause: unknown, toolName: ToolName, offerFeedback = false) {
  const info = reportToolError(cause, toolName);
  let text = `Error: ${info.message}`;
  if (info.retry_after_seconds !== undefined) {
    text += ` Retry after ${info.retry_after_seconds} seconds.`;
  } else if (info.retryable) {
    text += " This error is temporary; retry later.";
  }
  if (offerFeedback && (info.code === "invalid_query" || info.code === "internal")) {
    text += "\nIf this message doesn't tell you how to fix the call, report it with send_feedback.";
  }
  return {
    content: [
      { type: "text" as const, text },
      { type: "text" as const, text: JSON.stringify({ error: info }) },
    ],
    isError: true,
  };
}
