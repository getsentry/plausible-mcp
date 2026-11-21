import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { appToolMeta } from "../ui/resource.js";
import { toIsoSeconds } from "../plausible.js";
import type { PlausibleClient, PlausibleResponse } from "../plausible.js";
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

const MS_PER_DAY = 86_400_000;
const UTC_OFFSET = /(Z|([+-])(\d{2}):(\d{2}))$/;

/** The calendar date at `ms` in the zone of an ISO 8601 offset such as "-05:00". */
function localDate(ms: number, offset: string): string {
  const [, , sign, hours, minutes] = UTC_OFFSET.exec(offset) ?? [];
  const offsetMs = sign ? (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes)) * 60_000 : 0;
  return new Date(ms + offsetMs).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(date) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * The range of the same length right before period_b, built the way Plausible's dashboard
 * builds its previous period (lib/plausible/stats/comparisons.ex in plausible/analytics):
 * a range of whole days moves back by its own number of days, leaving out days after
 * today; "day" (today so far) and hour ranges move back by their length in time. It starts
 * from the range Plausible resolved for period_b, so an agent can compare "this week with
 * last week" without knowing today's date, which most prompts do not give.
 */
export function previousPeriod(periodB: string, resolved: unknown, now: number): string {
  const [first, last] = Array.isArray(resolved) ? resolved : [];
  if (
    typeof first !== "string" ||
    typeof last !== "string" ||
    Number.isNaN(Date.parse(first)) ||
    Number.isNaN(Date.parse(last))
  ) {
    throw new UserFacingError(
      "Plausible did not return the dates of period_b, so the period before it is unknown. Pass period_a."
    );
  }
  const start = Date.parse(first);
  const end = Date.parse(last);
  if (periodB === "day" || /^\d+h$/.test(periodB) || periodB.includes("T")) {
    const shift = periodB === "day" ? MS_PER_DAY : end - start;
    return `${toIsoSeconds(start - shift)},${toIsoSeconds(end - shift)}`;
  }
  const firstDate = first.slice(0, 10);
  // Today in the site's time zone, from the UTC offset Plausible gave the range's end.
  const today = localDate(now, last);
  const lastDate = last.slice(0, 10) < today ? last.slice(0, 10) : today;
  if (lastDate < firstDate) {
    throw new UserFacingError(
      "period_b starts after today, so the period before it has no fixed length. Pass period_a."
    );
  }
  const days = (Date.parse(lastDate) - Date.parse(firstDate)) / MS_PER_DAY + 1;
  return `${addDays(firstDate, -days)},${addDays(firstDate, -1)}`;
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
        "Compare metrics between two date ranges side by side. Ideal for before/after deploy analysis. period_a is the baseline and period_b is measured against it: deltas are period_b minus period_a, and percent is relative to period_a. To compare a period with the one of the same length right before it, such as this week with last week, pass only period_b (\"7d\").",
      _meta: appToolMeta,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      outputSchema: comparePeriodsOutputSchema,
      inputSchema: z.strictObject({
        site_id: siteIdSchemaFor(defaultSiteId),
        period_a: dateRangeSchema
          .describe(
            'Baseline ("before") date range that deltas are measured from, e.g. "2024-01-01,2024-01-07". Omit it to use the period of the same length right before period_b, as Plausible\'s "previous period" does: period_b "7d" alone compares the last 7 days with the 7 days before them. The result gives the dates used.'
          )
          .optional(),
        period_b: dateRangeSchema.describe(
          'Date range compared against period_a ("after"), e.g. "2024-01-08,2024-01-14". For a current-vs-prior comparison, this is the current range; omit period_a to compare it with the period right before it.'
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

        let periodA = args.period_a;
        let responseA: PlausibleResponse;
        let responseB: PlausibleResponse;
        if (periodA) {
          [responseA, responseB] = await Promise.all([
            client.query({ ...queryBase, date_range: periodA }),
            client.query({ ...queryBase, date_range: args.period_b }),
          ]);
        } else {
          responseB = await client.query({ ...queryBase, date_range: args.period_b });
          periodA = previousPeriod(args.period_b, responseB.query.date_range, Date.now());
          responseA = await client.query({ ...queryBase, date_range: periodA });
        }

        const metricsA = extractAggregateMetrics(responseA, metrics);
        const metricsB = extractAggregateMetrics(responseB, metrics);

        const comparison: PeriodComparison = {
          period_a: { range: periodA, metrics: metricsA },
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
