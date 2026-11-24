import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { appToolMeta } from "../ui/resource.js";
import { metricAmount, PLAUSIBLE_MAX_ROWS } from "../plausible.js";
import type { PlausibleClient, PlausibleResponse } from "../plausible.js";
import { toolErrorResult } from "../errors.js";
import { recordMcpClientInfo } from "../mcp-telemetry.js";
import {
  siteIdSchemaFor,
  dateRangeSchema,
  pageSchema,
  goalSchema,
  propertyFiltersSchema,
  buildQueryFilters,
  queryResultOutputSchema,
  buildQueryStructuredContent,
  CUSTOM_PROPERTY_PREFIX,
} from "../schemas.js";
import { resolveSiteId } from "./get-timeseries.js";

export function register(
  server: McpServer,
  client: PlausibleClient,
  defaultSiteId?: string,
  offerFeedback = false,
) {
  server.registerTool(
    "get_conversions",
    {
      title: "Get Conversions",
      description:
        "Get goal conversion rates and counts. Can break down by page to see which pages drive conversions.",
      _meta: appToolMeta,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      outputSchema: queryResultOutputSchema,
      inputSchema: z.strictObject({
        site_id: siteIdSchemaFor(defaultSiteId),
        date_range: dateRangeSchema,
        goal: goalSchema,
        page: pageSchema,
        property_filters: propertyFiltersSchema,
        breakdown_by_page: z
          .boolean()
          .default(false)
          .describe(
            "If true, adds event:page and each page's group_conversion_rate: the percent of that page's visitors who converted",
          )
          .optional(),
      }),
    },
    async (args, ctx) => {
      recordMcpClientInfo(ctx);
      try {
        const siteId = resolveSiteId(args.site_id, defaultSiteId);
        const queriedMetrics = ["visitors", "events", "conversion_rate"];
        const metrics = args.breakdown_by_page
          ? [...queriedMetrics, "group_conversion_rate"]
          : queriedMetrics;

        const filters = buildQueryFilters(args);

        const dimensions = args.breakdown_by_page ? ["event:goal", "event:page"] : ["event:goal"];

        // Plausible's own group_conversion_rate is always 0 when grouped by event:goal, so
        // the per-page rate is computed here the way Plausible computes it: converting
        // visitors over the page's visitors without the goal and props filters.
        const [conversions, pageTotals] = await Promise.all([
          client.query({
            site_id: siteId,
            metrics: queriedMetrics,
            date_range: args.date_range,
            dimensions,
            filters,
          }),
          args.breakdown_by_page
            ? client.query({
                site_id: siteId,
                metrics: ["visitors"],
                date_range: args.date_range,
                dimensions: ["event:page"],
                filters: filters.filter((f) => !isGoalOrPropsFilter(f)),
                pagination: { limit: PLAUSIBLE_MAX_ROWS },
              })
            : undefined,
        ]);
        const result = pageTotals ? withPageConversionRates(conversions, pageTotals) : conversions;

        const structuredContent = buildQueryStructuredContent(result, metrics, dimensions);
        const { notes } = structuredContent;
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ...result, notes }, null, 2) }],
          structuredContent,
        };
      } catch (error) {
        return toolErrorResult(error, "get_conversions", offerFeedback);
      }
    },
  );
}

function isGoalOrPropsFilter(filter: unknown[]): boolean {
  const dimension = String(filter[1]);
  return dimension === "event:goal" || dimension.startsWith(CUSTOM_PROPERTY_PREFIX);
}

/**
 * Append each [goal, page] row's group_conversion_rate, rounded to two decimals as
 * Plausible rounds it. A page missing from the totals (past Plausible's row limit) gets
 * null rather than a made-up rate.
 */
function withPageConversionRates(
  conversions: PlausibleResponse,
  pageTotals: PlausibleResponse,
): PlausibleResponse {
  const visitorsByPage = new Map(
    pageTotals.results.map((row) => [row.dimensions[0], row.metrics[0]]),
  );
  // The text block labels each row's values from query.metrics, so it names the new one too.
  const queriedMetrics = z.array(z.string()).safeParse(conversions.query.metrics);
  return {
    ...conversions,
    query: {
      ...conversions.query,
      ...(queriedMetrics.success && {
        metrics: [...queriedMetrics.data, "group_conversion_rate"],
      }),
    },
    results: conversions.results.map((row) => {
      const converted = metricAmount(row.metrics[0]);
      const total = metricAmount(visitorsByPage.get(row.dimensions[1]));
      const rate =
        converted === null || total === null
          ? null
          : total > 0
            ? Math.round((converted / total) * 10_000) / 100
            : 0;
      return { ...row, metrics: [...row.metrics, rate] };
    }),
  };
}
