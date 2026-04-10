import * as Sentry from "@sentry/cloudflare";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PlausibleApiError, type PlausibleClient } from "../plausible.js";
import { UserFacingError } from "../errors.js";
import {
  siteIdSchema,
  dateRangeSchema,
  pageSchema,
  goalSchema,
  metricsSchema,
  DEFAULT_METRICS,
  buildPageFilter,
  buildGoalFilter,
} from "../schemas.js";

export function resolveSiteId(
  explicit: string | undefined,
  defaultSiteId: string | undefined
): string {
  const siteId = explicit ?? defaultSiteId;
  if (!siteId) {
    throw new UserFacingError(
      "site_id is required. Pass it explicitly or set PLAUSIBLE_DEFAULT_SITE_ID."
    );
  }
  return siteId;
}

export function register(
  server: McpServer,
  client: PlausibleClient,
  defaultSiteId?: string
) {
  server.registerTool(
    "get_timeseries",
    {
      title: "Get Timeseries",
      description:
        "Get traffic and conversion metrics over time for a site or specific page. Use to spot trends and changes around deploys.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        site_id: siteIdSchema,
        date_range: dateRangeSchema,
        granularity: z
          .enum(["day", "week", "month"])
          .default("day")
          .describe("Time bucket size"),
        page: pageSchema,
        metrics: metricsSchema,
        goal: goalSchema,
      },
    },
    async (args) => {
      return Sentry.startSpan(
        { op: "mcp.server", name: "tools/call get_timeseries" },
        async (span) => {
          span.setAttribute("mcp.tool.name", "get_timeseries");
          span.setAttribute("mcp.method.name", "tools/call");
          span.setAttribute("mcp.transport", "http");
          span.setAttribute("network.transport", "tcp");

          try {
            const siteId = resolveSiteId(args.site_id, defaultSiteId);
            const metrics = args.metrics ?? DEFAULT_METRICS;
            const timeKey = `time:${args.granularity ?? "day"}`;

            span.setAttribute("plausible.site_id", siteId);
            span.setAttribute("plausible.date_range", args.date_range);
            if (args.page) span.setAttribute("plausible.page", args.page);
            if (args.goal) span.setAttribute("plausible.goal", args.goal);

            const filters: unknown[][] = [];
            if (args.page) filters.push(buildPageFilter(args.page));
            if (args.goal) filters.push(buildGoalFilter(args.goal));

            const result = await client.query({
              site_id: siteId,
              metrics,
              date_range: args.date_range,
              dimensions: [timeKey],
              filters,
            });

            span.setAttribute("mcp.tool.result.is_error", false);
            span.setAttribute("mcp.tool.result.content_count", result.results.length);

            return {
              content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            };
          } catch (error) {
            span.setAttribute("mcp.tool.result.is_error", true);
            Sentry.captureException(error);
            const message = error instanceof PlausibleApiError
              ? `Plausible API returned ${error.status}`
              : error instanceof UserFacingError
                ? error.message
                : "An unexpected error occurred";
            return {
              content: [{ type: "text" as const, text: `Error: ${message}` }],
              isError: true,
            };
          }
        }
      );
    }
  );
}
