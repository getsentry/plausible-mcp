import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PlausibleClient } from "../plausible.js";
import {
  siteIdSchema,
  dateRangeSchema,
  pageSchema,
  goalSchema,
  buildPageFilter,
  buildGoalFilter,
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
      annotations: { readOnlyHint: true },
      inputSchema: {
        site_id: siteIdSchema,
        date_range: dateRangeSchema,
        goal: goalSchema,
        page: pageSchema,
        breakdown_by_page: z
          .boolean()
          .default(false)
          .describe("If true, shows conversion rate per page")
          .optional(),
      },
    },
    async (args) => {
      const siteId = resolveSiteId(args.site_id, defaultSiteId);
      const metrics = ["visitors", "events", "conversion_rate"];

      const filters: unknown[][] = [];
      if (args.goal) filters.push(buildGoalFilter(args.goal));
      if (args.page) filters.push(buildPageFilter(args.page));

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
      };
    }
  );
}
