import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { appToolMeta } from "../ui/resource.js";
import { PLAUSIBLE_MAX_ROWS } from "../plausible.js";
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
  buildQueryFilters,
  queryResultOutputSchema,
  buildQueryStructuredContent,
} from "../schemas.js";

export function resolveSiteId(
  explicit: string | undefined,
  defaultSiteId: string | undefined,
): string {
  const siteId = explicit ?? defaultSiteId;
  if (!siteId) {
    throw new UserFacingError(
      "site_id is required. Pass it explicitly or set PLAUSIBLE_DEFAULT_SITE_ID.",
    );
  }
  return siteId;
}

export function register(
  server: McpServer,
  client: PlausibleClient,
  defaultSiteId?: string,
  offerFeedback = false,
) {
  server.registerTool(
    "get_timeseries",
    {
      title: "Get Timeseries",
      description:
        "Get traffic and conversion metrics over time for a site or specific page. Use to spot trends and changes around deploys.",
      _meta: appToolMeta,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      outputSchema: queryResultOutputSchema,
      inputSchema: z.strictObject({
        site_id: siteIdSchemaFor(defaultSiteId),
        date_range: dateRangeSchema,
        granularity: z.enum(["hour", "day", "week", "month"]).default("day"),
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

        const filters = buildQueryFilters(args);

        const result = await client.query({
          site_id: siteId,
          metrics,
          date_range: args.date_range,
          dimensions: [timeKey],
          filters,
        });
        // Plausible stops at its row limit without saying so; returning the rows would
        // present a series that silently ends early.
        if (result.results.length >= PLAUSIBLE_MAX_ROWS) {
          throw new UserFacingError(
            `This query reached Plausible's ${PLAUSIBLE_MAX_ROWS.toLocaleString("en-US")}-bucket limit, so later buckets may be missing. Narrow date_range or use a coarser granularity.`,
          );
        }

        const structuredContent = buildQueryStructuredContent(result, metrics, [timeKey]);
        const { notes } = structuredContent;
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ...result, notes }, null, 2) }],
          structuredContent,
        };
      } catch (error) {
        return toolErrorResult(error, "get_timeseries", offerFeedback);
      }
    },
  );
}
