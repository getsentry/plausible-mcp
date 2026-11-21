import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import {
  PlausibleClient,
  PlausibleApiError,
  parsePlausibleErrorDetail,
  PlausibleUnreachableError,
} from "../src/plausible.js";
import { dateRangeSchema } from "../src/schemas.js";
import { z } from "zod";
import type { JsonObject } from "../src/json.js";
import type { PlausibleQueryBody } from "../src/plausible.js";

const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", mockFetch);

function mockOk(data: JsonObject = { results: [], meta: {}, query: {} }) {
  mockFetch.mockResolvedValueOnce(Response.json(data));
}

function mockError(status: number, body: string, headers: Record<string, string> = {}) {
  mockFetch.mockResolvedValueOnce(new Response(body, { status, headers }));
}

const base = { site_id: "example.com", metrics: ["visitors"], date_range: "7d" };

function sentBody(call = 0): PlausibleQueryBody {
  // SAFETY: PlausibleClient sends JSON.stringify of a PlausibleQueryBody as the body.
  return JSON.parse(z.string().parse(mockFetch.mock.calls[call][1]?.body)) as PlausibleQueryBody;
}

/** The error a query rejects with; throws if it resolves. */
async function rejectionOf(query: Promise<unknown>): Promise<Error> {
  return query.then(
    () => {
      throw new Error("Expected the query to reject");
    },
    (cause: Error) => cause,
  );
}

describe("PlausibleClient", () => {
  let client: PlausibleClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new PlausibleClient({ apiKey: "test-key", baseUrl: "https://plausible.io" });
  });

  it("sends correct request to /api/v2/query", async () => {
    mockOk();

    await client.query({
      site_id: "example.com",
      metrics: ["visitors", "pageviews"],
      date_range: "30d",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://plausible.io/api/v2/query",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      }),
    );
    expect(sentBody()).toEqual({
      site_id: "example.com",
      metrics: ["visitors", "pageviews"],
      date_range: "30d",
    });
  });

  it("sends every comma range the schema accepts as the Plausible v2 [start, end] tuple", async () => {
    const date = fc
      .date({ min: new Date("2000-01-01"), max: new Date("2099-12-31"), noInvalidDate: true })
      .map((d) => d.toISOString());
    const offset = fc.constantFrom("Z", "+02:00", "-05:30");
    const range = fc.oneof(
      fc.tuple(date, date).map(([a, b]) => `${a.slice(0, 10)},${b.slice(0, 10)}`),
      fc
        .tuple(date, date, offset)
        .map(([a, b, o]) => `${a.slice(0, 19)}${o},${b.slice(0, 19)}${o}`),
    );
    await fc.assert(
      fc.asyncProperty(range, async (dateRange) => {
        expect(dateRangeSchema.safeParse(dateRange).success).toBe(true);
        mockFetch.mockReset();
        mockOk();

        await client.query({ ...base, date_range: dateRange });

        const sent = z.tuple([z.string(), z.string()]).parse(sentBody().date_range);
        expect(sent.join(",")).toBe(dateRange);
      }),
    );
  });

  it("wraps a rejected fetch as PlausibleUnreachableError", async () => {
    const cause = new TypeError("fetch failed");
    mockFetch.mockRejectedValueOnce(cause);

    const error = await client.query(base).catch((e) => e);

    expect(error).toBeInstanceOf(PlausibleUnreachableError);
    expect(error).toHaveProperty("cause", cause);
  });

  // Regression (bab4cf7): Plausible's only hour shorthand is "24h".
  it("sends any Nh range as a rolling datetime window of N hours ending now", async () => {
    vi.useFakeTimers();
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 9999 }),
          fc.date({
            min: new Date("2020-01-01"),
            max: new Date("2030-01-01"),
            noInvalidDate: true,
          }),
          async (hours, now) => {
            vi.setSystemTime(now);
            mockFetch.mockReset();
            mockOk();

            await client.query({ ...base, date_range: `${hours}h` });

            const [start, end] = z.tuple([z.string(), z.string()]).parse(sentBody().date_range);
            expect(end).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
            expect(Date.parse(end)).toBe(Math.floor(now.getTime() / 1000) * 1000);
            expect(Date.parse(end) - Date.parse(start)).toBe(hours * 3_600_000);
          },
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes dimensions, filters and pagination when provided", async () => {
    mockOk();

    await client.query({
      ...base,
      dimensions: ["time:day"],
      filters: [
        ["is", "event:page", ["/pricing"]],
        ["is", "event:goal", ["Signup"]],
      ],
      pagination: { limit: 10, offset: 5 },
    });

    expect(sentBody()).toMatchObject({
      dimensions: ["time:day"],
      filters: [
        ["is", "event:page", ["/pricing"]],
        ["is", "event:goal", ["Signup"]],
      ],
      pagination: { limit: 10, offset: 5 },
    });
  });

  it("includes order_by when provided and omits it when empty", async () => {
    mockOk();
    await client.query({
      ...base,
      order_by: [
        ["visitors", "desc"],
        ["event:page", "asc"],
      ],
    });
    expect(sentBody(0).order_by).toEqual([
      ["visitors", "desc"],
      ["event:page", "asc"],
    ]);

    mockOk();
    await client.query({ ...base, order_by: [] });
    expect(sentBody(1)).not.toHaveProperty("order_by");
  });

  it.each([
    [undefined, "https://plausible.io/api/v2/query"],
    ["https://analytics.mycompany.com/", "https://analytics.mycompany.com/api/v2/query"],
    ["http://localhost:8000", "http://localhost:8000/api/v2/query"],
  ])("sends base URL %s requests to %s", async (baseUrl, url) => {
    mockOk();

    await new PlausibleClient({ apiKey: "key", baseUrl }).query(base);

    expect(mockFetch).toHaveBeenCalledWith(url, expect.anything());
  });

  // The API key travels in the Authorization header, so it must not go over plain HTTP.
  it.each(["http://analytics.example.com", "ftp://plausible.io", "file:///etc/passwd"])(
    "refuses the base URL %s",
    (baseUrl) => {
      expect(() => new PlausibleClient({ apiKey: "key", baseUrl })).toThrow(/HTTPS/);
    },
  );

  it.each([400, 401, 402, 403, 404, 429, 500, 502, 503])(
    "throws PlausibleApiError carrying status %i and Plausible's error message",
    async (status) => {
      mockError(status, JSON.stringify({ error: "Invalid metric" }));

      const error = await client.query(base).catch((e) => e);

      expect(error).toBeInstanceOf(PlausibleApiError);
      expect(error.status).toBe(status);
      expect(error.detail).toBe("Invalid metric");
    },
  );

  describe("Retry-After", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-21T07:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function retryAfterFor(header?: string) {
      mockError(429, "Rate limit exceeded", header === undefined ? {} : { "Retry-After": header });
      const error = await rejectionOf(client.query(base));
      if (!(error instanceof PlausibleApiError)) throw error;
      return error.retryAfterSeconds;
    }

    it("reads delta-seconds and an HTTP-date for the same moment as the same wait", async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 0, max: 7 * 86_400 }), async (seconds) => {
          const date = new Date(Date.now() + seconds * 1000).toUTCString();
          expect(await retryAfterFor(String(seconds))).toBe(seconds);
          expect(await retryAfterFor(date)).toBe(seconds);
        }),
      );
    });

    it("rounds a fractional wait up", async () => {
      vi.setSystemTime(new Date("2026-10-21T07:00:00.500Z"));
      expect(await retryAfterFor("Wed, 21 Oct 2026 07:00:30 GMT")).toBe(30);
    });

    it("clamps a past date to 0", async () => {
      expect(await retryAfterFor("Wed, 21 Oct 2026 06:00:00 GMT")).toBe(0);
    });

    it.each(["Wednesday, 21-Oct-26 07:00:30 GMT", "Wed Oct 21 07:00:30 2026"])(
      "reads the obsolete HTTP-date form %j",
      async (header) => {
        expect(await retryAfterFor(header)).toBe(30);
      },
    );

    // Not valid Retry-After values, but Date.parse reads most of them as dates in 2001, which
    // would have told the caller to retry at once.
    it.each([
      "soon",
      "1.5",
      "-5",
      "5x",
      "1e3",
      "Monday 5",
      "January 1, 2001",
      "Monkeys 1 Jan 2001",
      "2026-10-21T07:00:30Z",
    ])("ignores the invalid value %j", async (header) => {
      expect(await retryAfterFor(header)).toBeUndefined();
    });

    it("leaves retryAfterSeconds undefined without a Retry-After header", async () => {
      expect(await retryAfterFor()).toBeUndefined();
    });
  });
});

describe("parsePlausibleErrorDetail", () => {
  it("extracts the error field", () => {
    expect(parsePlausibleErrorDetail('{"error":"bad metric"}')).toBe("bad metric");
  });

  it.each([
    "<html>502</html>",
    '{"errors":["bad"]}',
    '{"error":""}',
    '{"error":{"detail":"bad"}}',
    "null",
    '"bad"',
  ])("returns undefined for %s, which is not the documented shape", (body) => {
    expect(parsePlausibleErrorDetail(body)).toBeUndefined();
  });

  it("keeps a message of up to 500 characters and truncates a longer one", () => {
    const of = (n: number) => parsePlausibleErrorDetail(JSON.stringify({ error: "x".repeat(n) }));
    expect(of(500)).toBe("x".repeat(500));
    expect(of(900)).toBe(`${"x".repeat(500)}...`);
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
