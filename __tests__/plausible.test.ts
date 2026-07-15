import { describe, it, expect, vi, beforeEach } from "vitest";
import { PlausibleClient, PlausibleApiError } from "../src/plausible.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockOk(data: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

function mockError(status: number, body: string) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
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
