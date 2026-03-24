export interface PlausibleQueryParams {
  site_id: string;
  metrics: string[];
  date_range: string;
  dimensions?: string[];
  filters?: unknown[];
  pagination?: { limit: number; offset?: number };
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

export class PlausibleApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string
  ) {
    super(`Plausible API error ${status}: ${body}`);
    this.name = "PlausibleApiError";
  }
}

export interface PlausibleClientConfig {
  apiKey: string;
  baseUrl?: string;
}

export class PlausibleClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: PlausibleClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? "https://plausible.io").replace(
      /\/$/,
      ""
    );
  }

  async query(params: PlausibleQueryParams): Promise<PlausibleResponse> {
    const url = `${this.baseUrl}/api/v2/query`;

    const body: Record<string, unknown> = {
      site_id: params.site_id,
      metrics: params.metrics,
      date_range: params.date_range,
    };

    if (params.dimensions?.length) {
      body.dimensions = params.dimensions;
    }

    if (params.filters?.length) {
      body.filters =
        params.filters.length === 1 ? params.filters[0] : ["and", ...params.filters];
    }

    if (params.pagination) {
      body.pagination = params.pagination;
    }

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
