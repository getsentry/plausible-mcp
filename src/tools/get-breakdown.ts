import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { PlausibleClient } from "../plausible.js";
import { reportToolError } from "../errors.js";
import { recordMcpClientInfo } from "../mcp-telemetry.js";
import {
  siteIdSchemaFor,
  dateRangeSchema,
  pageSchema,
  metricsSchema,
  dimensionSchema,
  propertyFiltersSchema,
  isCustomPropertyDimension,
  buildPageFilter,
  buildPropertyFilters,
  assertNoShortcutOverlap,
  queryResultOutputSchema,
  buildQueryStructuredContent,
} from "../schemas.js";
import { resolveSiteId } from "./get-timeseries.js";

// Plausible rejects session metrics (bounce_rate) with goal/property dimensions,
// and event metrics (pageviews) with entry/exit page dimensions.
function defaultMetrics(dimension: string): string[] {
  if (dimension === "event:goal" || isCustomPropertyDimension(dimension)) {
    return ["visitors", "pageviews", "events"];
  }
  if (dimension === "visit:entry_page" || dimension === "visit:exit_page") {
    return ["visitors", "visits", "bounce_rate"];
  }
  return ["visitors", "pageviews", "bounce_rate"];
}

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
      inputSchema: z.object({
        site_id: siteIdSchemaFor(defaultSiteId),
        date_range: dateRangeSchema,
        dimension: dimensionSchema,
        page: pageSchema,
        property_filters: propertyFiltersSchema,
        metrics: metricsSchema,
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(20)
          .describe("Max results to return")
          .optional(),
      }),
    },
    async (args, ctx) => {
      recordMcpClientInfo(ctx);
      try {
        const siteId = resolveSiteId(args.site_id, defaultSiteId);
        const metrics = args.metrics ?? defaultMetrics(args.dimension);
        const limit = args.limit ?? 20;

        assertNoShortcutOverlap(args.property_filters, { page: args.page });
        const filters: unknown[][] = [];
        if (args.page) filters.push(buildPageFilter(args.page));
        if (args.property_filters?.length) {
          filters.push(...buildPropertyFilters(args.property_filters));
        }

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
        const message = reportToolError(error, "get_breakdown");
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
