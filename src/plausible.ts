export interface PlausibleQueryParams {
  site_id: string;
  metrics: string[];
  date_range: string;
  dimensions?: string[];
  filters?: unknown[];
  pagination?: { limit: number; offset?: number };
  include?: { total_rows?: boolean; imports?: boolean };
  order_by?: [string, "asc" | "desc"][];
}

export interface PlausibleResult {
  dimensions: (string | number)[];
  metrics: (number | null)[];
}

export interface PlausibleResponse {
  results: PlausibleResult[];
  meta?: Record<string, unknown>;
  query?: Record<string, unknown>;
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
export class PlausibleApiError extends Error {
  readonly detail: string | undefined;

  constructor(
    public readonly status: number,
    body: string
  ) {
    super(`Plausible API error ${status}`);
    Object.defineProperty(this, "detail", {
      value: parsePlausibleErrorDetail(body),
      enumerable: false,
    });
    this.name = "PlausibleApiError";
  }
}

export interface PlausibleClientConfig {
  apiKey: string;
  baseUrl?: string;
}

function encodeDateRange(dateRange: string): string | [string, string] {
  const absoluteRange = /^(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})$/.exec(dateRange);
  return absoluteRange ? [absoluteRange[1], absoluteRange[2]] : dateRange;
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

  /** Read-only Sites API requests always use this caller's key and configured host. */
  async getSitesMetadata(siteId?: string, after?: string): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/api/v1/sites${siteId ? `/${encodeURIComponent(siteId)}` : ""}`);
    if (!siteId) {
      url.searchParams.set("limit", "100");
      if (after) url.searchParams.set("after", after);
    }
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    // Do not propagate upstream bodies: they may contain inaccessible site identifiers.
    if (!response.ok) throw new PlausibleApiError(response.status, "");
    return response.json();
  }

  /** Goal configuration is independent of Stats API activity and uses the caller's key. */
  async getGoals(siteId: string, after?: string): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/api/v1/sites/goals`);
    url.searchParams.set("site_id", siteId);
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after", after);
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    // Configuration errors may echo private identifiers; expose status only.
    if (!response.ok) throw new PlausibleApiError(response.status, "");
    return response.json();
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

    if (params.include) body.include = params.include;
    if (params.order_by) body.order_by = params.order_by;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new PlausibleApiError(response.status, text);
    }

    return (await response.json()) as PlausibleResponse;
  }
}
