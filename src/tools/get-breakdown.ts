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
  queryResultOutputSchema,
  buildQueryStructuredContent,
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
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      outputSchema: queryResultOutputSchema,
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
      try {
        const siteId = resolveSiteId(args.site_id, defaultSiteId);
        const metrics = args.metrics ?? ["visitors", "pageviews", "bounce_rate"];
        const limit = args.limit ?? 20;

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

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: buildQueryStructuredContent(result, metrics, [args.dimension]),
        };
      } catch (error) {
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
