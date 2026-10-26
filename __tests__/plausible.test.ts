import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PlausibleClient,
  PlausibleApiError,
  parsePlausibleErrorDetail,
  PlausibleUnreachableError,
} from "../src/plausible.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockOk(data: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

function mockError(status: number, body: string, headers: Record<string, string> = {}) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    headers: new Headers(headers),
    text: () => Promise.resolve(body),
  });
}

describe("PlausibleClient", () => {
  let client: PlausibleClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new PlausibleClient({
      apiKey: "test-key",
      baseUrl: "https://plausible.io",
    });
  });

  it("sends correct request to /api/v2/query", async () => {
    mockOk({ results: [], meta: {}, query: {} });

    await client.query({
      site_id: "example.com",
      metrics: ["visitors", "pageviews"],
      date_range: "30d",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://plausible.io/api/v2/query",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
      })
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({
      site_id: "example.com",
      metrics: ["visitors", "pageviews"],
      date_range: "30d",
    });
  });

  it("encodes an absolute date range as the Plausible v2 tuple", async () => {
    mockOk({ results: [], meta: {}, query: {} });

    await client.query({
      site_id: "example.com",
      metrics: ["visitors"],
      date_range: "2026-07-01,2026-07-07",
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.date_range).toEqual(["2026-07-01", "2026-07-07"]);
  });

  it("wraps a rejected fetch as PlausibleUnreachableError", async () => {
    const cause = new TypeError("fetch failed");
    mockFetch.mockRejectedValueOnce(cause);

    const error = await client
      .query({ site_id: "example.com", metrics: ["visitors"], date_range: "7d" })
      .catch((e) => e);

    expect(error).toBeInstanceOf(PlausibleUnreachableError);
    expect((error as Error).cause).toBe(cause);
  });

  it("encodes a datetime range as the Plausible v2 tuple", async () => {
    mockOk({ results: [], meta: {}, query: {} });

    await client.query({
      site_id: "example.com",
      metrics: ["visitors"],
      date_range: "2026-07-01T09:00:00+02:00,2026-07-01T12:00:00+02:00",
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.date_range).toEqual(["2026-07-01T09:00:00+02:00", "2026-07-01T12:00:00+02:00"]);
  });

  it("sends an hour range as a rolling datetime window ending now", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T14:58:32.578Z"));
    mockOk({ results: [], meta: {}, query: {} });

    try {
      await client.query({ site_id: "example.com", metrics: ["events"], date_range: "1h" });
    } finally {
      vi.useRealTimers();
    }

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.date_range).toEqual(["2026-10-25T13:58:32Z", "2026-10-25T14:58:32Z"]);
  });

  it("includes dimensions when provided", async () => {
    mockOk({ results: [], meta: {}, query: {} });

    await client.query({
      site_id: "example.com",
      metrics: ["visitors"],
      date_range: "7d",
      dimensions: ["time:day"],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.dimensions).toEqual(["time:day"]);
  });

  it("passes single filter as array", async () => {
    mockOk({ results: [], meta: {}, query: {} });

    await client.query({
      site_id: "example.com",
      metrics: ["visitors"],
      date_range: "7d",
      filters: [["is", "event:page", ["/pricing"]]],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.filters).toEqual([["is", "event:page", ["/pricing"]]]);
  });

  it("passes multiple filters as array (implicit AND)", async () => {
    mockOk({ results: [], meta: {}, query: {} });

    await client.query({
      site_id: "example.com",
      metrics: ["visitors"],
      date_range: "7d",
      filters: [
        ["is", "event:page", ["/pricing"]],
        ["is", "event:goal", ["Signup"]],
      ],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.filters).toEqual([
      ["is", "event:page", ["/pricing"]],
      ["is", "event:goal", ["Signup"]],
    ]);
  });

  it("includes pagination when provided", async () => {
    mockOk({ results: [], meta: {}, query: {} });

    await client.query({
      site_id: "example.com",
      metrics: ["visitors"],
      date_range: "7d",
      pagination: { limit: 10, offset: 5 },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.pagination).toEqual({ limit: 10, offset: 5 });
  });

  it("includes order_by when provided and omits it when empty", async () => {
    mockOk({ results: [], meta: {}, query: {} });
    await client.query({
      site_id: "example.com",
      metrics: ["visitors"],
      date_range: "7d",
      order_by: [
        ["visitors", "desc"],
        ["event:page", "asc"],
      ],
    });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).order_by).toEqual([
      ["visitors", "desc"],
      ["event:page", "asc"],
    ]);

    mockOk({ results: [], meta: {}, query: {} });
    await client.query({
      site_id: "example.com",
      metrics: ["visitors"],
      date_range: "7d",
      order_by: [],
    });
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).not.toHaveProperty("order_by");
  });

  it("uses self-hosted base URL", async () => {
    const selfHosted = new PlausibleClient({
      apiKey: "key",
      baseUrl: "https://analytics.mycompany.com/",
    });

    mockOk({ results: [], meta: {}, query: {} });

    await selfHosted.query({
      site_id: "example.com",
      metrics: ["visitors"],
      date_range: "7d",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://analytics.mycompany.com/api/v2/query",
      expect.anything()
    );
  });

  it("strips trailing slash from base URL", async () => {
    const trailing = new PlausibleClient({
      apiKey: "key",
      baseUrl: "https://plausible.io/",
    });

    mockOk({ results: [], meta: {}, query: {} });

    await trailing.query({
      site_id: "example.com",
      metrics: ["visitors"],
      date_range: "7d",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://plausible.io/api/v2/query",
      expect.anything()
    );
  });

  it("defaults base URL to plausible.io", async () => {
    const defaultClient = new PlausibleClient({ apiKey: "key" });

    mockOk({ results: [], meta: {}, query: {} });

    await defaultClient.query({
      site_id: "example.com",
      metrics: ["visitors"],
      date_range: "7d",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://plausible.io/api/v2/query",
      expect.anything()
    );
  });

  it("throws PlausibleApiError on 401", async () => {
    mockError(401, "Invalid API key");

    await expect(
      client.query({
        site_id: "example.com",
        metrics: ["visitors"],
        date_range: "7d",
      })
    ).rejects.toThrow(PlausibleApiError);

    try {
      mockError(401, "Invalid API key");
      await client.query({
        site_id: "example.com",
        metrics: ["visitors"],
        date_range: "7d",
      });
    } catch (e) {
      expect(e).toBeInstanceOf(PlausibleApiError);
      expect((e as PlausibleApiError).status).toBe(401);
    }
  });

  it("throws PlausibleApiError on 429 rate limit", async () => {
    mockError(429, "Rate limit exceeded");

    await expect(
      client.query({
        site_id: "example.com",
        metrics: ["visitors"],
        date_range: "7d",
      })
    ).rejects.toThrow(PlausibleApiError);
  });

  it("exposes an integer Retry-After header as retryAfterSeconds", async () => {
    mockError(429, "Rate limit exceeded", { "Retry-After": "30" });

    const error = await client
      .query({ site_id: "example.com", metrics: ["visitors"], date_range: "7d" })
      .catch((e) => e);

    expect(error).toBeInstanceOf(PlausibleApiError);
    expect((error as PlausibleApiError).retryAfterSeconds).toBe(30);
  });

  describe("HTTP-date Retry-After", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-21T07:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function retryAfterFor(header: string) {
      mockError(429, "Rate limit exceeded", { "Retry-After": header });
      const error = await client
        .query({ site_id: "example.com", metrics: ["visitors"], date_range: "7d" })
        .catch((e) => e);
      return (error as PlausibleApiError).retryAfterSeconds;
    }

    it("converts a future date to seconds from now", async () => {
      expect(await retryAfterFor("Wed, 21 Oct 2026 07:00:30 GMT")).toBe(30);
    });

    it("rounds a fractional wait up", async () => {
      vi.setSystemTime(new Date("2026-10-21T07:00:00.500Z"));
      expect(await retryAfterFor("Wed, 21 Oct 2026 07:00:30 GMT")).toBe(30);
    });

    it("clamps a past date to 0", async () => {
      expect(await retryAfterFor("Wed, 21 Oct 2026 06:00:00 GMT")).toBe(0);
    });

    it("ignores an unparseable value", async () => {
      expect(await retryAfterFor("soon")).toBeUndefined();
    });
  });

  it("leaves retryAfterSeconds undefined without a Retry-After header", async () => {
    mockError(429, "Rate limit exceeded");

    const error = await client
      .query({ site_id: "example.com", metrics: ["visitors"], date_range: "7d" })
      .catch((e) => e);

    expect((error as PlausibleApiError).retryAfterSeconds).toBeUndefined();
  });

  it("throws PlausibleApiError on 500", async () => {
    mockError(500, "Internal Server Error");

    await expect(
      client.query({
        site_id: "example.com",
        metrics: ["visitors"],
        date_range: "7d",
      })
    ).rejects.toThrow(PlausibleApiError);
  });

  it("returns parsed response on success", async () => {
    const data = {
      results: [{ dimensions: ["2024-01-01"], metrics: [100, 200] }],
      meta: { imports_included: false },
      query: { site_id: "example.com" },
    };
    mockOk(data);

    const result = await client.query({
      site_id: "example.com",
      metrics: ["visitors", "pageviews"],
      date_range: "7d",
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].metrics).toEqual([100, 200]);
  });
});

describe("parsePlausibleErrorDetail", () => {
  it("extracts the error field", () => {
    expect(parsePlausibleErrorDetail('{"error":"bad metric"}')).toBe("bad metric");
  });

  it("returns undefined for a body that is not the documented shape", () => {
    expect(parsePlausibleErrorDetail("<html>502</html>")).toBeUndefined();
    expect(parsePlausibleErrorDetail('{"errors":["bad"]}')).toBeUndefined();
    expect(parsePlausibleErrorDetail('{"error":""}')).toBeUndefined();
    expect(parsePlausibleErrorDetail('{"error":{"detail":"bad"}}')).toBeUndefined();
  });

  it("truncates a long error message", () => {
    const detail = parsePlausibleErrorDetail(JSON.stringify({ error: "x".repeat(900) }));
    expect(detail).toBe(`${"x".repeat(500)}...`);
  });
});

describe("PlausibleApiError", () => {
  it("keeps an unparseable body out of the exception message", () => {
    const error = new PlausibleApiError(500, "site_id=example.com&token=secret");

    expect(error.message).toBe("Plausible API error 500");
    expect(error.detail).toBeUndefined();
  });

  it("keeps a parsed detail off the exception surface but available to the caller", () => {
    const error = new PlausibleApiError(500, '{"error":"failed filter customer@example.com"}');

    expect(error.message).toBe("Plausible API error 500");
    expect(error.detail).toBe("failed filter customer@example.com");
    expect(Object.keys(error)).not.toContain("detail");
    expect(JSON.stringify(error)).not.toContain("customer@example.com");
  });
});
