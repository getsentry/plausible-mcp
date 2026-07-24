import { z } from "zod";
import type { PlausibleResponse } from "./plausible.js";

export const VALID_METRICS = [
  "visitors",
  "visits",
  "pageviews",
  "views_per_visit",
  "bounce_rate",
  "visit_duration",
  "events",
  "scroll_depth",
  "percentage",
  "conversion_rate",
  "group_conversion_rate",
  "average_revenue",
  "total_revenue",
  "time_on_page",
] as const;

export const VALID_DIMENSIONS = [
  "event:page",
  "event:goal",
  "event:hostname",
  "visit:entry_page",
  "visit:exit_page",
  "visit:source",
  "visit:referrer",
  "visit:channel",
  "visit:utm_medium",
  "visit:utm_source",
  "visit:utm_campaign",
  "visit:utm_content",
  "visit:utm_term",
  "visit:device",
  "visit:browser",
  "visit:browser_version",
  "visit:os",
  "visit:os_version",
  "visit:country",
  "visit:region",
  "visit:city",
  // Human-readable geo names (vs the ISO/Geoname codes above). Prefer these when
  // presenting geography to end users. See issue #3.
  "visit:country_name",
  "visit:region_name",
  "visit:city_name",
] as const;

export const DEFAULT_METRICS = [
  "visitors",
  "pageviews",
  "bounce_rate",
  "visit_duration",
];

export const siteIdSchema = z
  .string()
  .describe(
    "Plausible site domain (e.g. example.com). Uses PLAUSIBLE_DEFAULT_SITE_ID if omitted."
  )
  .optional();

const requiredSiteIdSchema = z
  .string()
  .describe("Plausible site domain (e.g. example.com). Required.");

/**
 * site_id is only truly optional when the server has a default site to fall back
 * on. Without one, marking it required in the tool schema turns a guaranteed
 * runtime failure ("site_id is required") into an upfront validation error the
 * client can self-correct from the schema alone.
 */
export function siteIdSchemaFor(defaultSiteId: string | undefined) {
  return defaultSiteId ? siteIdSchema : requiredSiteIdSchema;
}

export const dateRangeSchema = z
  .string()
  .regex(
    /^(\d+h|\d+d|\d+mo|day|month|year|all|\d{4}-\d{2}-\d{2},\d{4}-\d{2}-\d{2})$/,
    'Must be "Nh", "Nd", "Nmo", "day", "month", "year", "all", or "YYYY-MM-DD,YYYY-MM-DD"'
  )
  .describe(
    'Date range: "7d", "30d", "12mo", "month", "year", "all", or "YYYY-MM-DD,YYYY-MM-DD"'
  );

export const pageSchema = z
  .string()
  .max(1024)
  .describe(
    "Filter by page path. Exact match by default, use * as trailing wildcard (e.g. /blog*)"
  )
  .optional();

export const goalSchema = z
  .string()
  .max(1024)
  .describe("Filter by goal name (e.g. Signup, Purchase)")
  .optional();

export const metricsSchema = z
  .array(z.enum(VALID_METRICS))
  .describe("Metrics to return. Defaults vary by tool.")
  .optional();

/**
 * Build a Plausible filter for a page path.
 * Trailing * → contains match, otherwise exact match.
 */
export function buildPageFilter(page: string): unknown[] {
  if (page.endsWith("*")) {
    const prefix = page.slice(0, -1);
    return ["contains", "event:page", [prefix]];
  }
  return ["is", "event:page", [page]];
}

/**
 * Build a Plausible filter for a goal name.
 */
export function buildGoalFilter(goal: string): unknown[] {
  return ["is", "event:goal", [goal]];
}

/**
 * Custom event properties are addressed in the Stats API v2 as `event:props:<name>`, both
 * as breakdown dimensions and as filter operands. The set of property names is defined by
 * whatever the site's own tracker sends, so it can't be enumerated here — the tools accept
 * any `event:props:<name>` generically.
 */
export const CUSTOM_PROPERTY_PREFIX = "event:props:";

export function isCustomPropertyDimension(value: string): boolean {
  return (
    value.startsWith(CUSTOM_PROPERTY_PREFIX) &&
    value.length > CUSTOM_PROPERTY_PREFIX.length
  );
}

const customPropertyDimensionSchema = z
  .string()
  .regex(
    /^event:props:\S/,
    'Custom property dimension must look like "event:props:<name>"'
  )
  .max(200);

export const dimensionSchema = z
  .union([z.enum(VALID_DIMENSIONS), customPropertyDimensionSchema])
  .describe(
    'Dimension to group results by: a standard dimension (e.g. event:page, visit:source), or a custom event property as "event:props:<name>" (e.g. event:props:plan).'
  );

export const PROPERTY_FILTER_OPERATORS = [
  "is",
  "is_not",
  "contains",
  "contains_not",
] as const;

export type PropertyFilter = {
  property: string;
  operator?: (typeof PROPERTY_FILTER_OPERATORS)[number];
  values: string[];
};

export const propertyFilterSchema = z.object({
  property: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'Custom property name WITHOUT the "event:props:" prefix (e.g. "plan" targets event:props:plan)'
    ),
  operator: z
    .enum(PROPERTY_FILTER_OPERATORS)
    .default("is")
    .describe("Match operator: is, is_not, contains, contains_not (default: is)"),
  values: z
    .array(z.string())
    .min(1)
    .describe("One or more values to match the property against"),
});

export const propertyFiltersSchema = z
  .array(propertyFilterSchema)
  .describe(
    'Filter by custom event properties, e.g. [{ "property": "plan", "operator": "is", "values": ["pro"] }]. Combined with other filters using AND.'
  )
  .optional();

/**
 * Build Plausible Stats API v2 filters for custom event properties.
 * Each entry becomes `[operator, "event:props:<name>", values]`.
 */
export function buildPropertyFilters(filters: PropertyFilter[]): unknown[][] {
  return filters.map((f) => [
    f.operator ?? "is",
    `${CUSTOM_PROPERTY_PREFIX}${f.property}`,
    f.values,
  ]);
}

/**
 * Shared `outputSchema` (a ZodRawShape) for the query-style tools. Declaring it makes the
 * tools return machine-readable `structuredContent` (validated by the MCP SDK) alongside the
 * human-readable text block. `metrics`/`dimensions` label the parallel arrays in each row so
 * consumers know what each number means without re-deriving it from the request.
 *
 * Value types are kept permissive (`number | string | null`) so an unexpected Plausible value
 * can't trip the SDK's output validation and turn a successful query into a tool error.
 */
export const queryResultOutputSchema = {
  metrics: z
    .array(z.string())
    .describe("Metric keys, in the order they appear in each row's `metrics` array"),
  dimensions: z
    .array(z.string())
    .describe("Dimension keys, in the order they appear in each row's `dimensions` array"),
  results: z
    .array(
      z.object({
        dimensions: z.array(z.union([z.string(), z.number()])),
        metrics: z.array(z.union([z.number(), z.string(), z.null()])),
      })
    )
    .describe("One row per dimension-value combination returned by Plausible"),
};

/**
 * Normalize a raw Plausible response into the `structuredContent` shape described by
 * {@link queryResultOutputSchema}, tagging the rows with the metric/dimension keys used.
 */
export function buildQueryStructuredContent(
  response: PlausibleResponse,
  metrics: string[],
  dimensions: string[]
) {
  return {
    metrics,
    dimensions,
    results: response.results.map((row) => ({
      dimensions: row.dimensions,
      metrics: row.metrics,
    })),
  };
}
