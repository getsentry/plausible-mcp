import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { PLAUSIBLE_MAX_ROWS, type PlausibleClient, type PlausibleResponse } from "../plausible.js";
import { UserFacingError, toolErrorResult } from "../errors.js";
import {
  siteIdSchemaFor,
  dateRangeSchema,
  pageSchema,
  goalSchema,
  propertyFiltersSchema,
  buildQueryFilters,
} from "../schemas.js";
import { resolveSiteId } from "./get-timeseries.js";
import { readPeriods } from "./compare-periods.js";
import { recordMcpClientInfo } from "../mcp-telemetry.js";

const dimensionSchema = z.enum(["event:page", "visit:source", "visit:channel"]);
const countSchema = z.number();
const directionSchema = z.enum(["losses", "gains", "largest_change"]);
export const groupedComparisonSchema = z.object({
  dimension: dimensionSchema,
  metric: z.enum(["visits", "pageviews"]),
  period_a: z.string(),
  period_b: z.string(),
  groups_compared: z.number(),
  results: z.array(
    z.object({ group: z.string(), before: z.number(), after: z.number(), change: z.number() }),
  ),
});

function groupCounts(response: PlausibleResponse) {
  if (response.results.length >= PLAUSIBLE_MAX_ROWS) {
    throw new UserFacingError(
      "This period reached the 10,000-row API limit. Narrow the dates or filters to rank a complete comparison.",
    );
  }
  const counts = new Map<string, number>();
  for (const row of response.results) {
    counts.set(String(row.dimensions[0]), countSchema.parse(row.metrics[0]));
  }
  return counts;
}

function compareGroups(
  a: PlausibleResponse,
  b: PlausibleResponse,
  direction: z.infer<typeof directionSchema>,
  limit: number,
) {
  const before = groupCounts(a),
    after = groupCounts(b);
  const groups = new Set([...before.keys(), ...after.keys()]);
  const rows = Array.from(groups, (group) => {
    const first = before.get(group) ?? 0,
      last = after.get(group) ?? 0;
    return { group, before: first, after: last, change: last - first };
  });
  const ranked = rows.filter((row) =>
    direction === "losses"
      ? row.change < 0
      : direction === "gains"
        ? row.change > 0
        : row.change !== 0,
  );
  ranked.sort((x, y) => Math.abs(y.change) - Math.abs(x.change) || x.group.localeCompare(y.group));
  return { groups_compared: groups.size, results: ranked.slice(0, limit) };
}

export function registerGroupedComparison(
  server: McpServer,
  client: PlausibleClient,
  defaultSiteId?: string,
  offerFeedback = false,
) {
  server.registerTool(
    "compare_breakdown",
    {
      title: "Compare pages or sources",
      description:
        "Find which pages gained or lost pageviews, or which sources or channels gained or lost visits between two periods. Ranks changes across all groups, including groups that appeared or disappeared. Set direction to losses for a drop.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: z.strictObject({
        site_id: siteIdSchemaFor(defaultSiteId),
        period_a: dateRangeSchema.optional(),
        period_b: dateRangeSchema,
        dimension: dimensionSchema,
        direction: directionSchema.default("largest_change"),
        limit: z.number().int().min(1).max(100).default(20),
        page: pageSchema,
        goal: goalSchema,
        property_filters: propertyFiltersSchema,
      }),
      outputSchema: groupedComparisonSchema,
    },
    async (args, ctx) => {
      recordMcpClientInfo(ctx);
      try {
        const metric = args.dimension === "event:page" ? "pageviews" : "visits";
        const base = {
          site_id: resolveSiteId(args.site_id, defaultSiteId),
          metrics: [metric],
          dimensions: [args.dimension],
          filters: buildQueryFilters(args),
          pagination: { limit: PLAUSIBLE_MAX_ROWS },
        };
        const { periodA, responseA, responseB } = await readPeriods(client, base, args);
        const result = {
          dimension: args.dimension,
          metric,
          period_a: periodA,
          period_b: args.period_b,
          ...compareGroups(responseA, responseB, args.direction, args.limit),
        };
        return {
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        return toolErrorResult(error, "compare_breakdown", offerFeedback);
      }
    },
  );
}
