import * as Sentry from "@sentry/cloudflare";
import { PlausibleApiError } from "./plausible.js";

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

/**
 * Preserve visibility into failed tool calls without turning expected caller errors into
 * exception issues. The MCP response remains an `isError` result; this function only decides
 * how the failure is represented in telemetry and which safe message the client receives.
 */
export function reportToolError(error: unknown, toolName: ToolName): string {
  if (error instanceof UserFacingError) {
    Sentry.metrics.count("mcp.tool.error", 1, {
      attributes: {
        "mcp.tool.name": toolName,
        "error.kind": "user_input",
      },
    });
    return error.message;
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
    return error.detail ? `${summary}: ${error.detail}` : summary;
  }

  Sentry.metrics.count("mcp.tool.error", 1, {
    attributes: {
      "mcp.tool.name": toolName,
      "error.kind": "unexpected",
    },
  });
  Sentry.captureException(error);
  return "An unexpected error occurred";
}
