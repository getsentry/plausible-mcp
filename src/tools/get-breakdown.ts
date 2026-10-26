import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { PLAUSIBLE_MAX_ROWS } from "../plausible.js";
import type { PlausibleClient, PlausibleResult } from "../plausible.js";
import { toolErrorResult } from "../errors.js";
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

function byFirstMetricThenName(a: PlausibleResult, b: PlausibleResult): number {
  const byMetric = (b.metrics[0] ?? 0) - (a.metrics[0] ?? 0);
  if (byMetric !== 0) return byMetric;
  const [nameA, nameB] = [String(a.dimensions[0]), String(b.dimensions[0])];
  return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
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
          .describe(
            "Max results to return per page. Use offset to fetch further pages; pagination.has_more in the result says whether more rows exist."
          )
          .optional(),
        offset: z
          .number()
          .int()
          .min(0)
          .describe("Number of rows to skip, for paging past the first `limit` rows")
          .optional(),
      }),
    },
    async (args, ctx) => {
      recordMcpClientInfo(ctx);
      try {
        const siteId = resolveSiteId(args.site_id, defaultSiteId);
        const metrics = args.metrics ?? defaultMetrics(args.dimension);
        const limit = args.limit ?? 20;
        const offset = args.offset ?? 0;

        assertNoShortcutOverlap(args.property_filters, { page: args.page });
        const filters: unknown[][] = [];
        if (args.page) filters.push(buildPageFilter(args.page));
        if (args.property_filters?.length) {
          filters.push(...buildPropertyFilters(args.property_filters));
        }

        // Plausible orders only by the first metric; without a tiebreaker, tied rows can
        // swap between requests and offset pages would skip or repeat them. Plausible
        // rejects event:goal in order_by, so goals (few per site) are fetched in full and
        // paged here over a stable order instead.
        const isGoal = args.dimension === "event:goal";
        const result = await client.query({
          site_id: siteId,
          metrics,
          date_range: args.date_range,
          dimensions: [args.dimension],
          filters,
          // One extra row reveals whether another page exists without relying on
          // include.total_rows, which older self-hosted versions lack.
          pagination: isGoal ? { limit: PLAUSIBLE_MAX_ROWS } : { limit: limit + 1, offset },
          order_by: isGoal
            ? [[metrics[0], "desc"]]
            : [
                [metrics[0], "desc"],
                [args.dimension, "asc"],
              ],
        });

        const rows = isGoal
          ? [...result.results].sort(byFirstMetricThenName).slice(offset, offset + limit + 1)
          : result.results;
        const trimmed = { ...result, results: rows.slice(0, limit) };
        const pagination = { limit, offset, has_more: rows.length > limit };

        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ ...trimmed, pagination }, null, 2) },
          ],
          structuredContent: buildQueryStructuredContent(
            trimmed,
            metrics,
            [args.dimension],
            pagination
          ),
        };
      } catch (error) {
        return toolErrorResult(error, "get_breakdown");
      }
    }
  );
}
