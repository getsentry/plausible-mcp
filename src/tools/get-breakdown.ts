import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { appToolMeta } from "../ui/resource.js";
import { metricAmount, PLAUSIBLE_MAX_ROWS } from "../plausible.js";
import type { PlausibleClient, PlausibleResult } from "../plausible.js";
import { toolErrorResult, UserFacingError } from "../errors.js";
import { recordMcpClientInfo } from "../mcp-telemetry.js";
import {
  siteIdSchemaFor,
  dateRangeSchema,
  pageSchema,
  goalSchema,
  rowMetricsSchema,
  dimensionSchema,
  propertyFiltersSchema,
  isCustomPropertyDimension,
  buildQueryFilters,
  queryResultOutputSchema,
  buildQueryStructuredContent,
} from "../schemas.js";
import { resolveSiteId } from "./get-timeseries.js";

// Plausible rejects session metrics (bounce_rate) with goal/property dimensions and with
// event:hostname unless event:page is also a dimension, which a single-dimension breakdown
// never has. It rejects event metrics (pageviews) with entry/exit page dimensions.
function baseMetrics(dimension: string): string[] {
  if (
    dimension === "event:goal" ||
    dimension === "event:hostname" ||
    isCustomPropertyDimension(dimension)
  ) {
    return ["visitors", "pageviews", "events"];
  }
  if (dimension === "visit:entry_page" || dimension === "visit:exit_page") {
    return ["visitors", "visits", "bounce_rate"];
  }
  return ["visitors", "pageviews", "bounce_rate"];
}

// A goal breakdown by anything but the goal is almost always asking for each row's
// conversion rate, so give it one rather than leaving the agent to pick conversion_rate,
// which divides by every visitor in the query (feedback PLAUSIBLE-MCP-V).
function defaultMetrics(dimension: string, hasGoal: boolean): string[] {
  const metrics = baseMetrics(dimension);
  return hasGoal && dimension !== "event:goal" ? [...metrics, "group_conversion_rate"] : metrics;
}

function byFirstMetricThenName(a: PlausibleResult, b: PlausibleResult): number {
  const first = a.metrics[0],
    second = b.metrics[0];
  const byMissingValue = Number(first == null) - Number(second == null);
  if (byMissingValue) return byMissingValue;
  if (first instanceof Object && second instanceof Object && first.currency !== second.currency) {
    return first.currency.localeCompare(second.currency);
  }
  const byMetric = (metricAmount(b.metrics[0]) ?? 0) - (metricAmount(a.metrics[0]) ?? 0);
  if (byMetric !== 0) return byMetric;
  const [nameA, nameB] = [String(a.dimensions[0]), String(b.dimensions[0])];
  return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
}

function breakdownInputSchema(defaultSiteId: string | undefined) {
  return z.strictObject({
    site_id: siteIdSchemaFor(defaultSiteId),
    date_range: dateRangeSchema,
    dimension: dimensionSchema,
    page: pageSchema,
    goal: goalSchema,
    property_filters: propertyFiltersSchema,
    metrics: rowMetricsSchema,
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(20)
      .describe("Rows per page. Advance offset when pagination.has_more is true.")
      .optional(),
    offset: z.number().int().min(0).describe("Rows to skip.").optional(),
  });
}

type BreakdownArgs = z.infer<ReturnType<typeof breakdownInputSchema>>;

function breakdownMetrics(args: BreakdownArgs): string[] {
  const hasGoal = !!args.goal || !!args.property_filters?.some((f) => f.property === "event:goal");
  const metrics = args.metrics ?? defaultMetrics(args.dimension, hasGoal);
  // Plausible accepts this pair but every row comes back 0.
  if (args.dimension === "event:goal" && metrics.includes("group_conversion_rate")) {
    throw new UserFacingError(
      "group_conversion_rate is always 0 when grouped by event:goal. Use conversion_rate, which is each goal's percent of all visitors.",
    );
  }
  return metrics;
}

/** One page of a breakdown: `limit` rows from `offset`, and whether more rows follow. */
async function queryBreakdownPage(
  client: PlausibleClient,
  siteId: string,
  args: BreakdownArgs,
  metrics: string[],
) {
  const limit = args.limit ?? 20;
  const offset = args.offset ?? 0;
  // Plausible orders only by the first metric; without a tiebreaker, tied rows can swap
  // between requests and offset pages would skip or repeat them. Plausible rejects
  // event:goal in order_by, so goals (few per site) are fetched in full and paged here
  // over a stable order instead.
  const isGoal = args.dimension === "event:goal";
  const result = await client.query({
    site_id: siteId,
    metrics,
    date_range: args.date_range,
    dimensions: [args.dimension],
    filters: buildQueryFilters(args),
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
  return {
    page: { ...result, results: rows.slice(0, limit) },
    pagination: { limit, offset, has_more: rows.length > limit },
  };
}

export function register(
  server: McpServer,
  client: PlausibleClient,
  defaultSiteId?: string,
  offerFeedback = false,
) {
  server.registerTool(
    "get_breakdown",
    {
      title: "Get Breakdown",
      description:
        "Rank one dimension, e.g. top pages or traffic sources. For a named goal's rate per landing page or source, set goal and use group_conversion_rate.",
      _meta: appToolMeta,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      outputSchema: queryResultOutputSchema,
      inputSchema: breakdownInputSchema(defaultSiteId),
    },
    async (args, ctx) => {
      recordMcpClientInfo(ctx);
      try {
        const siteId = resolveSiteId(args.site_id, defaultSiteId);
        const metrics = breakdownMetrics(args);
        const { page, pagination } = await queryBreakdownPage(client, siteId, args, metrics);
        const structuredContent = buildQueryStructuredContent(
          page,
          metrics,
          [args.dimension],
          pagination,
        );
        const { notes } = structuredContent;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...page, pagination, notes }, null, 2),
            },
          ],
          structuredContent,
        };
      } catch (error) {
        return toolErrorResult(error, "get_breakdown", offerFeedback);
      }
    },
  );
}
