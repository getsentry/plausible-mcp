import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { PlausibleClient } from "../plausible.js";
import { toolErrorResult, UserFacingError } from "../errors.js";
import { recordMcpClientInfo } from "../mcp-telemetry.js";
import {
  siteIdSchemaFor,
  dateRangeSchema,
  pageSchema,
  goalSchema,
  metricsSchema,
  propertyFiltersSchema,
  DEFAULT_METRICS,
  buildPageFilter,
  buildGoalFilter,
  buildPropertyFilters,
  assertNoShortcutOverlap,
  queryResultOutputSchema,
  buildQueryStructuredContent,
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
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      outputSchema: queryResultOutputSchema,
      inputSchema: z.object({
        site_id: siteIdSchemaFor(defaultSiteId),
        date_range: dateRangeSchema,
        granularity: z
          .enum(["hour", "day", "week", "month"])
          .default("day")
          .describe('Time bucket size. Use "hour" with a sub-day or few-day date_range.'),
        page: pageSchema,
        metrics: metricsSchema,
        goal: goalSchema,
        property_filters: propertyFiltersSchema,
      }),
    },
    async (args, ctx) => {
      recordMcpClientInfo(ctx);
      try {
        const siteId = resolveSiteId(args.site_id, defaultSiteId);
        const metrics = args.metrics ?? DEFAULT_METRICS;
        const timeKey = `time:${args.granularity ?? "day"}`;

        assertNoShortcutOverlap(args.property_filters, {
          page: args.page,
          goal: args.goal,
        });
        const filters: unknown[][] = [];
        if (args.page) filters.push(buildPageFilter(args.page));
        if (args.goal) filters.push(buildGoalFilter(args.goal));
        if (args.property_filters?.length) {
          filters.push(...buildPropertyFilters(args.property_filters));
        }

        const result = await client.query({
          site_id: siteId,
          metrics,
          date_range: args.date_range,
          dimensions: [timeKey],
          filters,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: buildQueryStructuredContent(result, metrics, [timeKey]),
        };
      } catch (error) {
        return toolErrorResult(error, "get_timeseries");
      }
    }
  );
}
