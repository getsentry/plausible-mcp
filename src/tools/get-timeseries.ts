import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PlausibleClient } from "../plausible.js";
import {
  siteIdSchema,
  dateRangeSchema,
  pageSchema,
  goalSchema,
  metricsSchema,
  DEFAULT_METRICS,
  buildPageFilter,
  buildGoalFilter,
} from "../schemas.js";

export function resolveSiteId(
  explicit: string | undefined,
  defaultSiteId: string | undefined
): string {
  const siteId = explicit ?? defaultSiteId;
  if (!siteId) {
    throw new Error(
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
      annotations: { readOnlyHint: true },
      inputSchema: {
        site_id: siteIdSchema,
        date_range: dateRangeSchema,
        granularity: z
          .enum(["day", "week", "month"])
          .default("day")
          .describe("Time bucket size"),
        page: pageSchema,
        metrics: metricsSchema,
        goal: goalSchema,
      },
    },
    async (args) => {
      const siteId = resolveSiteId(args.site_id, defaultSiteId);
      const metrics = args.metrics ?? DEFAULT_METRICS;
      const timeKey = `time:${args.granularity ?? "day"}`;

      const filters: unknown[][] = [];
      if (args.page) filters.push(buildPageFilter(args.page));
      if (args.goal) filters.push(buildGoalFilter(args.goal));

      const result = await client.query({
        site_id: siteId,
        metrics,
        date_range: args.date_range,
        dimensions: [timeKey],
        filters,
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
