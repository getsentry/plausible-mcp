import { z } from "zod";
import type { PlausibleResponse } from "./plausible.js";
import { queryResultOutputSchema } from "./schemas.js";

export const offsetSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 10000)
  .default(0).optional().describe("Zero-based row offset; use next_offset from the previous result");
export const paginatedResultOutputSchema = queryResultOutputSchema.extend({
  pagination: z.object({
    limit: z.number(), offset: z.number(), returned_rows: z.number(),
    total_rows: z.number().nullable(), has_more: z.boolean().nullable(),
    next_offset: z.number().nullable(),
    completeness: z.enum(["complete", "partial", "unknown"]),
    warnings: z.array(z.string()),
  }),
});

/** Keep the existing metric ranking, and break ties by every grouping dimension. */
export function paginationOrder(metrics: string[], dimensions: string[]): [string, "asc" | "desc"][] {
  return [[metrics[0], "desc"], ...dimensions.map((dimension): [string, "asc"] => [dimension, "asc"])];
}

export function buildPagination(response: PlausibleResponse, limit: number, offset: number) {
  const count = response.results.length;
  const rawTotal = response.meta.total_rows;
  const total = typeof rawTotal === "number" && Number.isSafeInteger(rawTotal) && rawTotal >= 0
    ? rawTotal : null;
  const end = offset + count;
  const warnings: string[] = [];
  const inconsistent = total !== null && ((count > 0 && end > total) || (count === 0 && offset < total));
  const hasMore = total === null || inconsistent ? null : end < total;
  if (total === null) warnings.push("Total row count unavailable; completeness cannot be verified, even for a short or empty page. Upstream caps may prevent exhaustive retrieval.");
  if (inconsistent || (count < limit && hasMore === true)) {
    warnings.push("Upstream returned fewer rows than expected or inconsistent totals. A cap or changing data may prevent exhaustive retrieval.");
  }
  return {
    limit, offset, returned_rows: count, total_rows: total, has_more: hasMore,
    next_offset: count > 0 && hasMore !== false ? end : null,
    completeness: total === null || inconsistent ? "unknown" as const
      : offset === 0 && count === total ? "complete" as const : "partial" as const,
    warnings,
  };
}
