import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { z } from "zod";
import {
  buildResultNotes,
  CONVERSION_RATES_MEANING,
  VALID_DIMENSIONS,
  PROPERTY_FILTER_OPERATORS,
  buildPropertyFilters,
  isCustomPropertyDimension,
  dimensionSchema,
  dateRangeSchema,
  propertyFilterSchema,
  assertNoShortcutOverlap,
} from "../src/schemas.js";

describe("isCustomPropertyDimension", () => {
  it("rejects the bare prefix with no name", () => {
    expect(isCustomPropertyDimension("event:props:")).toBe(false);
  });
});

describe("dateRangeSchema", () => {
  it("accepts N hours, days or months for any N, and the named periods", () => {
    fc.assert(
      fc.property(fc.nat(100_000), fc.constantFrom("h", "d", "mo"), (n, unit) => {
        expect(dateRangeSchema.safeParse(`${n}${unit}`).success).toBe(true);
      }),
    );
    for (const period of ["day", "month", "year", "all"]) {
      expect(dateRangeSchema.safeParse(period).success).toBe(true);
    }
  });

  it.each([
    "2026-07-01,2026-07-07",
    "2026-07-01T09:00:00Z,2026-07-01T12:00:00Z",
    "2026-07-01T09:00:00+02:00,2026-07-01T12:00:00-05:00",
  ])("accepts %s", (value) => {
    expect(dateRangeSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    "10m",
    "7w",
    "-7d",
    "2026-07-01T09:00:00,2026-07-01T12:00:00",
    "2026-07-01T09:00Z,2026-07-01T12:00Z",
    "2026-07-01,2026-07-01T12:00:00Z",
  ])("rejects %s", (value) => {
    expect(dateRangeSchema.safeParse(value).success).toBe(false);
  });
});

describe("dimensionSchema", () => {
  it("parses a custom property name beginning with whitespace", () => {
    expect(dimensionSchema.safeParse("event:props: plan").success).toBe(true);
  });

  it("accepts a 300-character custom property name", () => {
    const propertyName = "p".repeat(300);

    expect(dimensionSchema.safeParse(`event:props:${propertyName}`).success).toBe(true);
  });

  it("rejects a custom property name longer than 300 characters", () => {
    const propertyName = "p".repeat(301);

    expect(dimensionSchema.safeParse(`event:props:${propertyName}`).success).toBe(false);
  });

  it("rejects an unknown dimension", () => {
    expect(dimensionSchema.safeParse("event:nonsense").success).toBe(false);
  });

  it("rejects the bare custom-property prefix", () => {
    expect(dimensionSchema.safeParse("event:props:").success).toBe(false);
  });
});

describe("propertyFilterSchema", () => {
  it("defaults the operator to is", () => {
    const parsed = propertyFilterSchema.parse({ property: "plan", values: ["pro"] });
    expect(parsed.operator).toBe("is");
  });

  it("rejects a filter value longer than the cap", () => {
    expect(
      propertyFilterSchema.safeParse({ property: "plan", values: ["x".repeat(1025)] }).success,
    ).toBe(false);
    expect(
      propertyFilterSchema.safeParse({ property: "plan", values: ["x".repeat(1024)] }).success,
    ).toBe(true);
  });

  it("rejects an empty values array", () => {
    expect(propertyFilterSchema.safeParse({ property: "plan", values: [] }).success).toBe(false);
  });

  it("accepts a 300-character property name", () => {
    const property = "p".repeat(300);

    expect(propertyFilterSchema.safeParse({ property, values: ["enterprise"] }).success).toBe(true);
  });

  it("rejects a property name longer than 300 characters", () => {
    const property = "p".repeat(301);

    expect(propertyFilterSchema.safeParse({ property, values: ["enterprise"] }).success).toBe(
      false,
    );
  });

  it("accepts a fully-qualified event:props: property", () => {
    expect(
      propertyFilterSchema.safeParse({
        property: "event:props:plan",
        values: ["enterprise"],
      }).success,
    ).toBe(true);
  });

  it.each(VALID_DIMENSIONS)("accepts the built-in dimension %s as a property", (property) => {
    expect(propertyFilterSchema.safeParse({ property, values: ["x"] }).success).toBe(true);
  });

  it("rejects an unknown dimension-like property instead of prefixing it", () => {
    const result = propertyFilterSchema.safeParse({
      property: "visit:chanel",
      values: ["Organic Search"],
    });
    expect(result.success).toBe(false);
  });

  // Plausible rejects negated goal filters.
  it.each(PROPERTY_FILTER_OPERATORS)(
    "accepts event:goal with %s only if it is not negated",
    (operator) => {
      const result = propertyFilterSchema.safeParse({
        property: "event:goal",
        operator,
        values: ["Signup"],
      });
      expect(result.success).toBe(operator === "is" || operator === "contains");
    },
  );
});

describe("buildPropertyFilters", () => {
  it("prefixes the property name and defaults the operator to is", () => {
    expect(buildPropertyFilters([{ property: "plan", values: ["pro"] }])).toEqual([
      ["is", "event:props:plan", ["pro"]],
    ]);
  });

  it("passes through explicit operators and multiple values", () => {
    expect(
      buildPropertyFilters([
        { property: "destination_host", operator: "contains", values: ["github", "gitlab"] },
      ]),
    ).toEqual([["contains", "event:props:destination_host", ["github", "gitlab"]]]);
  });

  it("does not double-prefix a fully-qualified event:props: property", () => {
    expect(buildPropertyFilters([{ property: "event:props:plan", values: ["pro"] }])).toEqual([
      ["is", "event:props:plan", ["pro"]],
    ]);
  });

  it("builds the same filter from a bare name and from the target it produced", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z_]{1,20}$/), (name) => {
        const [[, target]] = buildPropertyFilters([{ property: name, values: ["x"] }]);
        expect(
          buildPropertyFilters([{ property: z.string().parse(target), values: ["x"] }]),
        ).toEqual(buildPropertyFilters([{ property: name, values: ["x"] }]));
      }),
    );
  });
});

describe("assertNoShortcutOverlap", () => {
  it("passes when the shortcut param is absent", () => {
    expect(() =>
      assertNoShortcutOverlap([{ property: "event:page", values: ["/docs"] }], {}),
    ).not.toThrow();
  });
});

describe("buildResultNotes", () => {
  it("explains conversion_rate when rows are grouped by more than the goal", () => {
    expect(buildResultNotes(["visitors", "conversion_rate"], ["visit:entry_page"])).toEqual([
      CONVERSION_RATES_MEANING,
    ]);
    expect(buildResultNotes(["conversion_rate"], ["time:day"])).toEqual([CONVERSION_RATES_MEANING]);
    expect(buildResultNotes(["conversion_rate"], ["event:goal", "event:page"])).toEqual([
      CONVERSION_RATES_MEANING,
    ]);
  });

  it("adds nothing for a goal-only grouping or a result without conversion_rate", () => {
    expect(buildResultNotes(["visitors", "conversion_rate"], ["event:goal"])).toEqual([]);
    expect(buildResultNotes(["visitors", "group_conversion_rate"], ["event:page"])).toEqual([]);
    expect(buildResultNotes(["visitors"], ["event:page"])).toEqual([]);
  });
});
