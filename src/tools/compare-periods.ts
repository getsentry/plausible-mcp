import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { appToolMeta } from "../ui/resource.js";
import type { PlausibleClient, PlausibleResponse } from "../plausible.js";
import { toolErrorResult } from "../errors.js";
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
} from "../schemas.js";
import { resolveSiteId } from "./get-timeseries.js";

type PeriodComparison = {
  period_a: { range: string; metrics: Record<string, number | null> };
  period_b: { range: string; metrics: Record<string, number | null> };
  deltas: Record<string, { absolute: number | null; percent: number | null }>;
};

const nullableNumber = z.union([z.number(), z.null()]);
const periodSchema = z.object({
  range: z.string().describe("The date range this period covers"),
  metrics: z
    .record(z.string(), nullableNumber)
    .describe("Aggregate value per requested metric for this period"),
});

/** `outputSchema` for compare_periods — two period aggregates plus per-metric deltas. */
const comparePeriodsOutputSchema = z.object({
  period_a: periodSchema,
  period_b: periodSchema,
  deltas: z
    .record(
      z.string(),
      z.object({ absolute: nullableNumber, percent: nullableNumber })
    )
    .describe(
      "Per-metric change from period_a (baseline) to period_b: absolute is period_b - period_a, percent is that change relative to period_a. A positive value means period_b is higher."
    ),
});

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
  defaultSiteId?: string,
  offerFeedback = false
) {
  server.registerTool(
    "compare_periods",
    {
      title: "Compare Periods",
      description:
        "Compare metrics between two date ranges side by side. Ideal for before/after deploy analysis. period_a is the baseline and period_b is measured against it: deltas are period_b minus period_a, and percent is relative to period_a. To see how the current period changed from a prior one, pass the prior range as period_a and the current range as period_b.",
      _meta: appToolMeta,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      outputSchema: comparePeriodsOutputSchema,
      inputSchema: z.object({
        site_id: siteIdSchemaFor(defaultSiteId),
        period_a: dateRangeSchema.describe(
          'Baseline ("before") date range that deltas are measured from, e.g. "2024-01-01,2024-01-07". For a current-vs-prior comparison, this is the prior range.'
        ),
        period_b: dateRangeSchema.describe(
          'Date range compared against period_a ("after"), e.g. "2024-01-08,2024-01-14". For a current-vs-prior comparison, this is the current range.'
        ),
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

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(comparison, null, 2) },
          ],
          structuredContent: comparison,
        };
      } catch (error) {
        return toolErrorResult(error, "compare_periods", offerFeedback);
      }
    }
  );
}

// Exported for testing
export { extractAggregateMetrics, computeDeltas };
