import { z } from "zod";
import type { JsonObject, JsonValue } from "./json.js";

export interface PlausibleQueryParams {
  site_id: string;
  metrics: string[];
  date_range: string;
  dimensions?: string[];
  filters?: unknown[];
  pagination?: { limit: number; offset?: number };
  order_by?: [string, "asc" | "desc"][];
}

export const revenueSchema = z.object({
  value: z.number(),
  currency: z.string(),
  short: z.string(),
  long: z.string(),
});
export type MetricValue = number | z.infer<typeof revenueSchema> | null;

export function metricAmount(value: MetricValue | undefined) {
  return value instanceof Object ? value.value : (value ?? null);
}

export interface PlausibleResult {
  dimensions: (string | number)[];
  metrics: MetricValue[];
}

export interface PlausibleResponse {
  results: PlausibleResult[];
  meta: JsonObject;
  /** Plausible's echo of the query as it resolved it, e.g. the absolute date_range. */
  query: JsonObject;
}

const errorBodySchema = z.object({ error: z.string().min(1) });

const MAX_ERROR_DETAIL_LENGTH = 500;

/**
 * Plausible reports failures as `{"error": "<message>"}`. Anything else — an HTML error page
 * from a proxy, a truncated body — carries no reliable signal and may echo back the request,
 * so only the documented shape is extracted. The cap bounds what reaches an MCP client and,
 * for 5xx, a Sentry exception message.
 */
export function parsePlausibleErrorDetail(body: string): string | undefined {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const errorBody = errorBodySchema.safeParse(parsed);
  if (!errorBody.success) return undefined;
  const detail = errorBody.data.error;
  return detail.length > MAX_ERROR_DETAIL_LENGTH
    ? `${detail.slice(0, MAX_ERROR_DETAIL_LENGTH)}...`
    : detail;
}

/**
 * `message` stays status-only because `reportToolError` captures this exception for 5xx, and
 * Sentry redacts neither exception messages nor enumerable error properties. An upstream error
 * can reflect the request back — a filter value, a site id — so the detail is kept off the
 * exception surface entirely and handed to the caller separately. `detail` is non-enumerable
 * so a serializer walking the error cannot pick it up either.
 */
/** Plausible's largest pagination limit, and its default: a query returns at most this many rows. */
export const PLAUSIBLE_MAX_ROWS = 10_000;

/** fetch rejected before Plausible sent a response: DNS, TLS, or a dropped connection. */
export class PlausibleUnreachableError extends Error {
  constructor(cause: unknown) {
    super("Could not reach the Plausible API", { cause });
    this.name = "PlausibleUnreachableError";
  }
}

export class PlausibleApiError extends Error {
  readonly detail: string | undefined;

  constructor(
    public readonly status: number,
    body: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(`Plausible API error ${status}`);
    Object.defineProperty(this, "detail", {
      value: parsePlausibleErrorDetail(body),
      enumerable: false,
    });
    this.name = "PlausibleApiError";
  }
}

/**
 * The HTTP-date forms of RFC 9110: IMF-fixdate, RFC 850 and asctime. `Date.parse` reads
 * almost anything as a date ("1.5" and "Monday 5" both land in 2001), which would tell the
 * caller to retry at once, so only these forms reach it.
 */
const GMT_HTTP_DATE = [
  /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/,
  /^[A-Z][a-z]{5,8}, \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT$/,
];
/** asctime carries no zone but is GMT by definition; `Date.parse` would read it as local time. */
const ASCTIME_DATE = /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/;

/** Retry-After is either delta-seconds or an HTTP-date; both are normalized to seconds from now. */
function parseRetryAfterSeconds(header: string | null): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  let date: number;
  if (GMT_HTTP_DATE.some((form) => form.test(value))) date = Date.parse(value);
  else if (ASCTIME_DATE.test(value)) date = Date.parse(`${value} GMT`);
  else return undefined;
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : undefined;
}

/** The JSON body of a Stats API v2 query. */
export interface PlausibleQueryBody {
  site_id: string;
  metrics: string[];
  date_range: string | [string, string];
  dimensions?: string[];
  filters?: unknown[];
  pagination?: { limit: number; offset?: number };
  order_by?: [string, "asc" | "desc"][];
  include?: {
    imports?: boolean;
    time_labels?: boolean;
    total_rows?: boolean;
    trim_relative_date_range?: boolean;
  };
}

export interface PlausibleClientConfig {
  apiKey: string;
  baseUrl?: string;
}

const MS_PER_HOUR = 3_600_000;

export function toIsoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function encodeDateRange(dateRange: string): string | [string, string] {
  // Plausible's only hour shorthand is "24h", so every "Nh" is sent as the
  // equivalent rolling datetime window.
  const hours = /^(\d+)h$/.exec(dateRange);
  if (hours) {
    const now = Date.now();
    return [toIsoSeconds(now - Number(hours[1]) * MS_PER_HOUR), toIsoSeconds(now)];
  }
  const [start, end] = dateRange.split(",");
  return end === undefined ? dateRange : [start, end];
}

export class PlausibleClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: PlausibleClientConfig) {
    this.apiKey = config.apiKey;
    const raw = (config.baseUrl ?? "https://plausible.io").replace(/\/$/, "");
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("baseUrl must use HTTPS (or HTTP for localhost)");
    }
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
      throw new Error("baseUrl must use HTTPS");
    }
    this.baseUrl = raw;
  }

  async query(params: PlausibleQueryParams): Promise<PlausibleResponse> {
    const body: PlausibleQueryBody = {
      site_id: params.site_id,
      metrics: params.metrics,
      date_range: encodeDateRange(params.date_range),
    };

    if (params.dimensions?.length) {
      body.dimensions = params.dimensions;
    }

    if (params.filters?.length) {
      body.filters = params.filters;
    }

    if (params.pagination) {
      body.pagination = params.pagination;
    }

    if (params.order_by?.length) {
      body.order_by = params.order_by;
    }

    return this.queryBody(body);
  }

  async metadata(
    path: "sites" | "goals" | "custom-props",
    params: URLSearchParams,
  ): Promise<JsonValue> {
    const suffix = path === "sites" ? "" : "/" + path;
    const url = new URL(this.baseUrl + "/api/v1/sites" + suffix);
    url.search = params.toString();
    return this.request(url.href, { method: "GET" });
  }

  async queryBody(body: PlausibleQueryBody): Promise<PlausibleResponse> {
    // SAFETY: /api/v2/query returns ordered metric rows. Every public tool validates
    // its structured result against its declared MCP output schema.
    return this.request<PlausibleResponse>(this.baseUrl + "/api/v2/query", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        // A Workers fetch that follows a cross-origin redirect can forward the bearer key.
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
      });
    } catch (cause) {
      throw new PlausibleUnreachableError(cause);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new PlausibleApiError(
        response.status,
        text,
        parseRetryAfterSeconds(response.headers.get("Retry-After")),
      );
    }

    // SAFETY: callers either parse metadata with their endpoint schema or validate Stats rows through the MCP output schema.
    return (await response.json()) as T;
  }
}
