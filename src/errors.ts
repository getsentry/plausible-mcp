import * as Sentry from "@sentry/cloudflare";
import { PlausibleApiError, PlausibleUnreachableError } from "./plausible.js";

export type ToolName =
  | "get_timeseries"
  | "get_breakdown"
  | "get_conversions"
  | "compare_periods";

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
}

/**
 * Preserve visibility into failed tool calls without turning expected caller errors into
 * exception issues. The MCP response remains an `isError` result; this function only decides
 * how the failure is represented in telemetry and which safe message and code the client receives.
 */
export function reportToolError(error: unknown, toolName: ToolName): ToolErrorInfo {
  if (error instanceof UserFacingError) {
    Sentry.metrics.count("mcp.tool.error", 1, {
      attributes: {
        "mcp.tool.name": toolName,
        "error.kind": "user_input",
      },
    });
    return { code: "invalid_input", message: error.message, retryable: false };
  }

  if (error instanceof PlausibleApiError) {
    Sentry.metrics.count("mcp.tool.error", 1, {
      attributes: {
        "mcp.tool.name": toolName,
        "error.kind": "plausible_api",
        "http.response.status_code": error.status,
      },
    });
    if (error.status >= 500) Sentry.captureException(error);

    let summary: string;
    if (error.status === 401) {
      summary = "Plausible rejected the API key or site_id (401)";
    } else if (error.status === 429) {
      summary = "Plausible rate limit exceeded (429)";
    } else {
      summary = `Plausible API returned ${error.status}`;
    }
    const message = error.detail ? `${summary}: ${error.detail}` : summary;

    if (error.status === 401 || error.status === 403) {
      return { code: "unauthorized", message, retryable: false };
    }
    if (error.status === 429 || error.status >= 500) {
      return {
        code: error.status === 429 ? "rate_limited" : "upstream_unavailable",
        message,
        retryable: true,
        ...(error.retryAfterSeconds !== undefined && {
          retry_after_seconds: error.retryAfterSeconds,
        }),
      };
    }
    return { code: "invalid_query", message, retryable: false };
  }

  if (error instanceof PlausibleUnreachableError) {
    Sentry.metrics.count("mcp.tool.error", 1, {
      attributes: {
        "mcp.tool.name": toolName,
        "error.kind": "plausible_unreachable",
      },
    });
    Sentry.captureException(error);
    return { code: "upstream_unavailable", message: error.message, retryable: true };
  }

  Sentry.metrics.count("mcp.tool.error", 1, {
    attributes: {
      "mcp.tool.name": toolName,
      "error.kind": "unexpected",
    },
  });
  Sentry.captureException(error);
  return { code: "internal", message: "An unexpected error occurred", retryable: false };
}

/**
 * Failed tool result: a human-readable text block followed by the machine-readable error as
 * JSON. `structuredContent` is omitted because MCP SDK v1 clients validate it against the
 * success `outputSchema` even when `isError` is true, which would turn the error into a
 * protocol failure.
 */
export function toolErrorResult(error: unknown, toolName: ToolName) {
  const info = reportToolError(error, toolName);
  let text = `Error: ${info.message}`;
  if (info.retry_after_seconds !== undefined) {
    text += ` Retry after ${info.retry_after_seconds} seconds.`;
  } else if (info.retryable) {
    text += " This error is temporary; retry later.";
  }
  return {
    content: [
      { type: "text" as const, text },
      { type: "text" as const, text: JSON.stringify({ error: info }) },
    ],
    isError: true,
  };
}
