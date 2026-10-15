import { includeImportsSchema, buildImportCoverage } from "../imports.js";
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
  goalSchema,
  propertyFiltersSchema,
  buildPageFilter,
  buildGoalFilter,
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
    "get_conversions",
    {
      title: "Get Conversions",
      description:
        "Get goal conversion rates and counts. Can break down by page to see which pages drive conversions. Use limit/offset to paginate; inspect pagination.completeness before treating results as exhaustive.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      outputSchema: paginatedResultOutputSchema,
      inputSchema: z.object({
        site_id: siteIdSchemaFor(defaultSiteId),
        date_range: dateRangeSchema,
        goal: goalSchema,
        page: pageSchema,
        property_filters: propertyFiltersSchema,
        include_imports: includeImportsSchema,
        offset: offsetSchema,
        limit: z.number().int().min(1).max(10000).default(10000).optional()
          .describe("Maximum rows per page (default 10000)"),
        breakdown_by_page: z
          .boolean()
          .default(false)
          .describe("If true, shows conversion rate per page")
          .optional(),
      }),
    },
    async (args, ctx) => {
      recordMcpClientInfo(ctx);
      try {
        const siteId = resolveSiteId(args.site_id, defaultSiteId);
        const metrics = ["visitors", "events", "conversion_rate"];
        const limit = args.limit ?? 10000;
        const offset = args.offset ?? 0;

        assertNoShortcutOverlap(args.property_filters, {
          page: args.page,
          goal: args.goal,
        });
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
          pagination: { limit, offset },
          include: { total_rows: true, ...(args.include_imports !== undefined ? { imports: args.include_imports } : {}) },
          order_by: paginationOrder(metrics, dimensions),
        });

        const pagination = buildPagination(result, limit, offset);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ...result, ...buildImportCoverage(result, args.include_imports), pagination }, null, 2) }],
          structuredContent: { ...buildQueryStructuredContent(result, metrics, dimensions, args.include_imports), pagination },
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
