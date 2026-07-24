import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PlausibleClient } from "../plausible.js";
import { reportToolError } from "../errors.js";
import {
  siteIdSchemaFor,
  dateRangeSchema,
  pageSchema,
  goalSchema,
  propertyFiltersSchema,
  buildPageFilter,
  buildGoalFilter,
  buildPropertyFilters,
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
    "get_conversions",
    {
      title: "Get Conversions",
      description:
        "Get goal conversion rates and counts. Can break down by page to see which pages drive conversions.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      outputSchema: queryResultOutputSchema,
      inputSchema: {
        site_id: siteIdSchemaFor(defaultSiteId),
        date_range: dateRangeSchema,
        goal: goalSchema,
        page: pageSchema,
        property_filters: propertyFiltersSchema,
        breakdown_by_page: z
          .boolean()
          .default(false)
          .describe("If true, shows conversion rate per page")
          .optional(),
      },
    },
    async (args) => {
      try {
        const siteId = resolveSiteId(args.site_id, defaultSiteId);
        const metrics = ["visitors", "events", "conversion_rate"];

        const filters: unknown[][] = [];
        if (args.goal) filters.push(buildGoalFilter(args.goal));
        if (args.page) filters.push(buildPageFilter(args.page));
        if (args.property_filters?.length) {
          filters.push(...buildPropertyFilters(args.property_filters));
        }

        const dimensions = args.breakdown_by_page
          ? ["event:goal", "event:page"]
          : ["event:goal"];

        const result = await client.query({
          site_id: siteId,
          metrics,
          date_range: args.date_range,
          dimensions,
          filters,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: buildQueryStructuredContent(result, metrics, dimensions),
        };
      } catch (error) {
        const message = reportToolError(error, "get_conversions");
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
