import { includeImportsSchema, buildImportCoverage } from "../imports.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { PlausibleClient } from "../plausible.js";
import { reportToolError } from "../errors.js";
import { recordMcpClientInfo } from "../mcp-telemetry.js";
import {
  siteIdSchemaFor,
  dateRangeSchema,
  pageSchema,
  goalSchema,
  metricsSchema,
  propertyFiltersSchema,
  buildPageFilter,
  buildGoalFilter,
  buildPropertyFilters,
  assertNoShortcutOverlap,
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
    "get_aggregate",
    {
      title: "Get Aggregate",
      description:
        "Get interval-wide aggregate metrics with one dimensionless query. Use for a single-period KPI overview; do not sum daily visitors or average daily rates. Defaults to visitors, visits, pageviews, bounce_rate and visit_duration. Supports page, goal, property filters and imported history; upstream compatibility rules still apply.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      outputSchema: queryResultOutputSchema,
      inputSchema: z.object({
        site_id: siteIdSchemaFor(defaultSiteId),
        date_range: dateRangeSchema,
        page: pageSchema,
        metrics: metricsSchema,
        goal: goalSchema,
        property_filters: propertyFiltersSchema,
        include_imports: includeImportsSchema,
      }),
    },
    async (args, ctx) => {
      recordMcpClientInfo(ctx);
      try {
        const siteId = resolveSiteId(args.site_id, defaultSiteId);
        const metrics = args.metrics ?? ["visitors", "visits", "pageviews", "bounce_rate", "visit_duration"];

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
          ...(args.include_imports !== undefined ? { include: { imports: args.include_imports } } : {}),
          site_id: siteId,
          metrics,
          date_range: args.date_range,
          dimensions: [],
          filters,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ...result, ...buildImportCoverage(result, args.include_imports) }, null, 2) }],
          structuredContent: buildQueryStructuredContent(result, metrics, [], args.include_imports),
        };
      } catch (error) {
        const message = reportToolError(error, "get_aggregate");
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
