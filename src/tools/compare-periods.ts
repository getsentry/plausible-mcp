import * as Sentry from "@sentry/cloudflare";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PlausibleApiError, type PlausibleClient, type PlausibleResponse } from "../plausible.js";
import { UserFacingError } from "../errors.js";
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
import { resolveSiteId } from "./get-timeseries.js";

interface PeriodComparison {
  period_a: { range: string; metrics: Record<string, number | null> };
  period_b: { range: string; metrics: Record<string, number | null> };
  deltas: Record<string, { absolute: number | null; percent: number | null }>;
}

function extractAggregateMetrics(
  response: PlausibleResponse,
  metricNames: string[]
): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  if (response.results.length > 0) {
    const row = response.results[0];
    for (let i = 0; i < metricNames.length; i++) {
      result[metricNames[i]] = row.metrics[i];
    }
  }
  return result;
}

function computeDeltas(
  a: Record<string, number | null>,
  b: Record<string, number | null>
): Record<string, { absolute: number | null; percent: number | null }> {
  const deltas: Record<string, { absolute: number | null; percent: number | null }> = {};
  for (const key of Object.keys(a)) {
    const va = a[key];
    const vb = b[key];
    if (va == null || vb == null) {
      deltas[key] = { absolute: null, percent: null };
    } else {
      const abs = vb - va;
      const pct = va !== 0 ? (abs / va) * 100 : null;
      deltas[key] = {
        absolute: Math.round(abs * 100) / 100,
        percent: pct != null ? Math.round(pct * 100) / 100 : null,
      };
    }
  }
  return deltas;
}

export function register(
  server: McpServer,
  client: PlausibleClient,
  defaultSiteId?: string
) {
  server.registerTool(
    "compare_periods",
    {
      title: "Compare Periods",
      description:
        "Compare metrics between two date ranges side by side. Ideal for before/after deploy analysis. Returns aggregate values for each period plus the delta (absolute and %).",
      annotations: { readOnlyHint: true },
      inputSchema: {
        site_id: siteIdSchema,
        period_a: dateRangeSchema.describe(
          'First date range, e.g. "2024-01-01,2024-01-07" or "7d"'
        ),
        period_b: dateRangeSchema.describe(
          'Second date range, e.g. "2024-01-08,2024-01-14" or "7d"'
        ),
        page: pageSchema,
        metrics: metricsSchema,
        goal: goalSchema,
      },
    },
    async (args) => {
      return Sentry.startSpan(
        { op: "mcp.server", name: "tools/call compare_periods" },
        async (span) => {
          span.setAttribute("mcp.tool.name", "compare_periods");
          span.setAttribute("mcp.method.name", "tools/call");
          span.setAttribute("mcp.transport", "http");
          span.setAttribute("network.transport", "tcp");

          try {
            const siteId = resolveSiteId(args.site_id, defaultSiteId);
            const metrics = args.metrics ?? DEFAULT_METRICS;

            span.setAttribute("plausible.site_id", siteId);
            span.setAttribute("plausible.period_a", args.period_a);
            span.setAttribute("plausible.period_b", args.period_b);
            if (args.page) span.setAttribute("plausible.page", args.page);
            if (args.goal) span.setAttribute("plausible.goal", args.goal);

            const filters: unknown[][] = [];
            if (args.page) filters.push(buildPageFilter(args.page));
            if (args.goal) filters.push(buildGoalFilter(args.goal));

            const queryBase = {
              site_id: siteId,
              metrics,
              filters,
            };

            const [responseA, responseB] = await Promise.all([
              client.query({ ...queryBase, date_range: args.period_a }),
              client.query({ ...queryBase, date_range: args.period_b }),
            ]);

            const metricsA = extractAggregateMetrics(responseA, metrics);
            const metricsB = extractAggregateMetrics(responseB, metrics);

            const comparison: PeriodComparison = {
              period_a: { range: args.period_a, metrics: metricsA },
              period_b: { range: args.period_b, metrics: metricsB },
              deltas: computeDeltas(metricsA, metricsB),
            };

            span.setAttribute("mcp.tool.result.is_error", false);

            return {
              content: [
                { type: "text" as const, text: JSON.stringify(comparison, null, 2) },
              ],
            };
          } catch (error) {
            span.setAttribute("mcp.tool.result.is_error", true);
            Sentry.captureException(error);
            const message = error instanceof PlausibleApiError
              ? `Plausible API returned ${error.status}`
              : error instanceof UserFacingError
                ? error.message
                : "An unexpected error occurred";
            return {
              content: [{ type: "text" as const, text: `Error: ${message}` }],
              isError: true,
            };
          }
        }
      );
    }
  );
}

// Exported for testing
export { extractAggregateMetrics, computeDeltas };
