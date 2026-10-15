import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { PlausibleClient } from "../plausible.js";
import { reportToolError } from "../errors.js";
import { recordMcpClientInfo } from "../mcp-telemetry.js";
import {
  offsetSchema,
  paginatedResultOutputSchema,
  paginationOrder,
  buildPagination,
} from "../pagination.js";
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
        "Break down metrics by a dimension: page, traffic source, country, device, etc. Use to find top pages, sources, or segment traffic. Use limit/offset to paginate; inspect pagination.completeness before treating results as exhaustive.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      outputSchema: paginatedResultOutputSchema,
      inputSchema: z.object({
        site_id: siteIdSchemaFor(defaultSiteId),
        date_range: dateRangeSchema,
        dimension: dimensionSchema,
        page: pageSchema,
        property_filters: propertyFiltersSchema,
        offset: offsetSchema,
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
        const metrics =
          args.metrics ??
          (isCustomPropertyDimension(args.dimension)
            ? ["visitors", "pageviews", "events"]
            : ["visitors", "pageviews", "bounce_rate"]);
        const limit = args.limit ?? 20;
        const offset = args.offset ?? 0;

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
          pagination: { limit, offset },
          include: { total_rows: true },
          order_by: paginationOrder(metrics, [args.dimension]),
        });

        const pagination = buildPagination(result, limit, offset);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ...result, pagination }, null, 2) }],
          structuredContent: { ...buildQueryStructuredContent(result, metrics, [args.dimension]), pagination },
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
