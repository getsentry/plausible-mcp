// Behavior every query tool shares, checked once per tool through a real MCP client.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { connect, errorOf, plausibleError, QUERY_TOOLS, type Harness } from "../harness.js";

let h: Harness;
beforeEach(async () => {
  h = await connect();
});
afterEach(() => h.close());

describe.each(QUERY_TOOLS)("$name", ({ name, args }) => {
  it("queries the default site with the configured key when site_id is omitted", async () => {
    const result = await h.call(name, args);

    expect(result.isError).toBeFalsy();
    expect(h.requests.length).toBeGreaterThan(0);
    for (const request of h.requests) {
      expect(request.url).toBe("https://plausible.io/api/v2/query");
      expect(request.authorization).toBe("Bearer test-key");
      expect(request.body.site_id).toBe("example.com");
    }
  });

  it("queries an explicit site_id instead of the default", async () => {
    const result = await h.call(name, { ...args, site_id: "other.example" });

    expect(result.isError).toBeFalsy();
    expect(h.requests.length).toBeGreaterThan(0);
    for (const request of h.requests) expect(request.body.site_id).toBe("other.example");
  });

  it("sends the page, goal and property filters to Plausible", async () => {
    const result = await h.call(name, {
      ...args,
      page: "/blog*",
      goal: "Signup",
      property_filters: [
        { property: "plan", values: ["pro"] },
        { property: "visit:channel", operator: "is_not", values: ["Direct"] },
      ],
    });

    expect(result.isError).toBeFalsy();
    expect(h.requests.length).toBeGreaterThan(0);
    for (const request of h.requests) {
      expect(request.body.filters).toEqual(
        expect.arrayContaining([
          ["contains", "event:page", ["/blog"]],
          ["is", "event:goal", ["Signup"]],
          ["is", "event:props:plan", ["pro"]],
          ["is_not", "visit:channel", ["Direct"]],
        ]),
      );
      expect(request.body.filters).toHaveLength(4);
    }
  });

  it.each([
    ["page", "/pricing", "event:page"],
    ["goal", "Signup", "event:goal"],
  ])(
    "rejects the %s shortcut with a filter on the same dimension, before any request",
    async (param, value, property) => {
      const result = await h.call(name, {
        ...args,
        [param]: value,
        property_filters: [{ property, values: ["other"] }],
      });

      expect(result.isError).toBe(true);
      expect(errorOf(result).code).toBe("invalid_input");
      expect(h.requests).toHaveLength(0);
    },
  );

  it("returns a retryable rate_limited error with Plausible's wait time", async () => {
    h.reply(() => plausibleError(429, "", { "Retry-After": "30" }));

    const result = await h.call(name, args);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(errorOf(result)).toMatchObject({
      code: "rate_limited",
      retryable: true,
      retry_after_seconds: 30,
    });
  });

  it("passes Plausible's error message back for a rejected query", async () => {
    h.reply(() => plausibleError(400, JSON.stringify({ error: "Invalid filter 'x'" })));

    const result = await h.call(name, args);

    expect(errorOf(result)).toMatchObject({ code: "invalid_query", retryable: false });
    expect(errorOf(result).message).toContain("Invalid filter 'x'");
  });

  // The client validates structuredContent against the tool's outputSchema, so a result
  // that does not match it surfaces as a thrown protocol error, not a passing call.
  it("returns structuredContent that matches its output schema for any rows Plausible sends", async () => {
    const value = fc.oneof(fc.double({ noNaN: true, noDefaultInfinity: true }), fc.constant(null));
    const row = fc.record({
      dimensions: fc.array(fc.oneof(fc.string(), fc.integer()), { maxLength: 2 }),
      metrics: fc.array(value, { minLength: 4, maxLength: 4 }),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(row, { maxLength: 8 }), async (rows) => {
        h.reply(() => rows);
        const result = await h.call(name, args);
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toBeDefined();
      }),
      { numRuns: 30 },
    );
  });
});

describe("without a default site", () => {
  let bare: Harness;
  beforeEach(async () => {
    bare = await connect({ defaultSiteId: undefined });
  });
  afterEach(() => bare.close());

  it("lists site_id as required on every query tool", async () => {
    const { tools } = await bare.client.listTools();
    const siteTools = tools.filter((tool) => tool.name !== "list_sites");
    expect(siteTools.map((tool) => [tool.name, tool.inputSchema.required])).toEqual(
      siteTools.map((tool) => [tool.name, expect.arrayContaining(["site_id"])]),
    );
  });

  it.each(QUERY_TOOLS)(
    "rejects $name without site_id before any request",
    async ({ name, args }) => {
      const result = await bare.call(name, args);

      expect(result.isError).toBe(true);
      expect(result.content.map((block) => block.text).join("\n")).toContain("site_id");
      expect(bare.requests).toHaveLength(0);
    },
  );
});

describe("with a default site", () => {
  it("lists site_id as optional", async () => {
    const { tools } = await h.client.listTools();
    expect(tools.filter((tool) => tool.inputSchema.required?.includes("site_id"))).toEqual([]);
  });
});
