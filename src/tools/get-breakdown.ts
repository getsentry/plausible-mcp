import * as Sentry from "@sentry/cloudflare";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PlausibleApiError, type PlausibleClient } from "../plausible.js";
import { UserFacingError } from "../errors.js";
import {
  siteIdSchema,
  dateRangeSchema,
  pageSchema,
  metricsSchema,
  VALID_DIMENSIONS,
  buildPageFilter,
} from "../schemas.js";
import { resolveSiteId } from "./get-timeseries.js";

export function register(
  server: McpServer,
  client: PlausibleClient,
  defaultSiteId?: string
) {
  server.registerTool(
    "get_breakdown",
    {
      title: "Get Breakdown",
      description:
        "Break down metrics by a dimension: page, traffic source, country, device, etc. Use to find top pages, sources, or segment traffic.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        site_id: siteIdSchema,
        date_range: dateRangeSchema,
        dimension: z
          .enum(VALID_DIMENSIONS)
          .describe("Dimension to group results by"),
        page: pageSchema,
        metrics: metricsSchema,
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(20)
          .describe("Max results to return")
          .optional(),
      },
    },
    async (args) => {
      return Sentry.startSpan(
        { op: "mcp.server", name: "tools/call get_breakdown" },
        async (span) => {
          span.setAttribute("mcp.tool.name", "get_breakdown");
          span.setAttribute("mcp.method.name", "tools/call");
          span.setAttribute("mcp.transport", "http");
          span.setAttribute("network.transport", "tcp");

          try {
            const siteId = resolveSiteId(args.site_id, defaultSiteId);
            const metrics = args.metrics ?? ["visitors", "pageviews", "bounce_rate"];
            const limit = args.limit ?? 20;

            span.setAttribute("plausible.site_id", siteId);
            span.setAttribute("plausible.date_range", args.date_range);
            span.setAttribute("plausible.dimension", args.dimension);
            if (args.page) span.setAttribute("plausible.page", args.page);

            const filters: unknown[][] = [];
            if (args.page) filters.push(buildPageFilter(args.page));

            const result = await client.query({
              site_id: siteId,
              metrics,
              date_range: args.date_range,
              dimensions: [args.dimension],
              filters,
              pagination: { limit },
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
