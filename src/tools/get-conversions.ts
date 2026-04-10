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
  buildPageFilter,
  buildGoalFilter,
} from "../schemas.js";
import { resolveSiteId } from "./get-timeseries.js";

export function register(
  server: McpServer,
  client: PlausibleClient,
  defaultSiteId?: string
) {
  server.registerTool(
    "get_conversions",
    {
      title: "Get Conversions",
      description:
        "Get goal conversion rates and counts. Can break down by page to see which pages drive conversions.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        site_id: siteIdSchema,
        date_range: dateRangeSchema,
        goal: goalSchema,
        page: pageSchema,
        breakdown_by_page: z
          .boolean()
          .default(false)
          .describe("If true, shows conversion rate per page")
          .optional(),
      },
    },
    async (args) => {
      return Sentry.startSpan(
        { op: "mcp.server", name: "tools/call get_conversions" },
        async (span) => {
          span.setAttribute("mcp.tool.name", "get_conversions");
          span.setAttribute("mcp.method.name", "tools/call");
          span.setAttribute("mcp.transport", "http");
          span.setAttribute("network.transport", "tcp");

          try {
            const siteId = resolveSiteId(args.site_id, defaultSiteId);
            const metrics = ["visitors", "events", "conversion_rate"];

            span.setAttribute("plausible.site_id", siteId);
            span.setAttribute("plausible.date_range", args.date_range);
            if (args.goal) span.setAttribute("plausible.goal", args.goal);
            if (args.page) span.setAttribute("plausible.page", args.page);

            const filters: unknown[][] = [];
            if (args.goal) filters.push(buildGoalFilter(args.goal));
            if (args.page) filters.push(buildPageFilter(args.page));

            const dimensions = args.breakdown_by_page
              ? ["event:goal", "event:page"]
              : ["event:goal"];

            const result = await client.query({
              site_id: siteId,
              metrics,
              date_range: args.date_range,
              dimensions,
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
