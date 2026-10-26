export interface PlausibleQueryParams {
  site_id: string;
  metrics: string[];
  date_range: string;
  dimensions?: string[];
  filters?: unknown[];
  pagination?: { limit: number; offset?: number };
  order_by?: [string, "asc" | "desc"][];
}

export interface PlausibleResult {
  dimensions: (string | number)[];
  metrics: (number | null)[];
}

export interface PlausibleResponse {
  results: PlausibleResult[];
  meta: Record<string, unknown>;
  query: Record<string, unknown>;
}

const MAX_ERROR_DETAIL_LENGTH = 500;

/**
 * Plausible reports failures as `{"error": "<message>"}`. Anything else — an HTML error page
 * from a proxy, a truncated body — carries no reliable signal and may echo back the request,
 * so only the documented shape is extracted. The cap bounds what reaches an MCP client and,
 * for 5xx, a Sentry exception message.
 */
export function parsePlausibleErrorDetail(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const detail = (parsed as { error?: unknown } | null)?.error;
  if (typeof detail !== "string" || detail.length === 0) return undefined;
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
    public readonly retryAfterSeconds?: number
  ) {
    super(`Plausible API error ${status}`);
    Object.defineProperty(this, "detail", {
      value: parsePlausibleErrorDetail(body),
      enumerable: false,
    });
    this.name = "PlausibleApiError";
  }
}

/** Retry-After is either delta-seconds or an HTTP-date; both are normalized to seconds from now. */
function parseRetryAfterSeconds(header: string | null): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : undefined;
}

export interface PlausibleClientConfig {
  apiKey: string;
  baseUrl?: string;
}

const MS_PER_HOUR = 3_600_000;

function toIsoSeconds(ms: number): string {
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
    const url = `${this.baseUrl}/api/v2/query`;

    const body: Record<string, unknown> = {
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

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new PlausibleUnreachableError(cause);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new PlausibleApiError(
        response.status,
        text,
        parseRetryAfterSeconds(response.headers.get("Retry-After"))
      );
    }

    return (await response.json()) as PlausibleResponse;
  }
}
