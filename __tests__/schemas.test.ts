import { describe, it, expect } from "vitest";
import {
  buildPropertyFilters,
  isCustomPropertyDimension,
  dimensionSchema,
  propertyFilterSchema,
  assertNoShortcutOverlap,
} from "../src/schemas.js";

describe("isCustomPropertyDimension", () => {
  it("accepts event:props:<name>", () => {
    expect(isCustomPropertyDimension("event:props:plan")).toBe(true);
  });

  it("rejects standard dimensions", () => {
    expect(isCustomPropertyDimension("event:page")).toBe(false);
    expect(isCustomPropertyDimension("visit:source")).toBe(false);
  });

  it("rejects the bare prefix with no name", () => {
    expect(isCustomPropertyDimension("event:props:")).toBe(false);
  });
});

describe("dimensionSchema", () => {
  it("parses a standard dimension", () => {
    expect(dimensionSchema.safeParse("event:page").success).toBe(true);
    expect(dimensionSchema.safeParse("visit:country_name").success).toBe(true);
  });

  it("parses a custom property dimension", () => {
    expect(dimensionSchema.safeParse("event:props:destination_host").success).toBe(true);
  });

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
      propertyFilterSchema.safeParse({ property: "plan", values: ["x".repeat(1025)] })
        .success
    ).toBe(false);
    expect(
      propertyFilterSchema.safeParse({ property: "plan", values: ["x".repeat(1024)] })
        .success
    ).toBe(true);
  });

  it("rejects an empty values array", () => {
    expect(
      propertyFilterSchema.safeParse({ property: "plan", values: [] }).success
    ).toBe(false);
  });

  it("rejects an unknown operator", () => {
    expect(
      propertyFilterSchema.safeParse({
        property: "plan",
        operator: "matches",
        values: ["pro"],
      }).success
    ).toBe(false);
  });

  it("accepts a 300-character property name", () => {
    const property = "p".repeat(300);

    expect(propertyFilterSchema.safeParse({ property, values: ["enterprise"] }).success).toBe(
      true
    );
  });

  it("rejects a property name longer than 300 characters", () => {
    const property = "p".repeat(301);

    expect(propertyFilterSchema.safeParse({ property, values: ["enterprise"] }).success).toBe(
      false
    );
  });

  it("accepts a fully-qualified event:props: property", () => {
    expect(
      propertyFilterSchema.safeParse({
        property: "event:props:plan",
        values: ["enterprise"],
      }).success
    ).toBe(true);
  });

  it("accepts built-in dimensions", () => {
    for (const property of ["visit:channel", "visit:source", "event:page", "visit:country_name"]) {
      expect(
        propertyFilterSchema.safeParse({ property, values: ["x"] }).success
      ).toBe(true);
    }
  });

  it("rejects an unknown dimension-like property instead of prefixing it", () => {
    const result = propertyFilterSchema.safeParse({
      property: "visit:chanel",
      values: ["Organic Search"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects negated event:goal filters", () => {
    expect(
      propertyFilterSchema.safeParse({
        property: "event:goal",
        operator: "is_not",
        values: ["Signup"],
      }).success
    ).toBe(false);
  });

  it("accepts is and contains on event:goal", () => {
    for (const operator of ["is", "contains"] as const) {
      expect(
        propertyFilterSchema.safeParse({
          property: "event:goal",
          operator,
          values: ["Signup"],
        }).success
      ).toBe(true);
    }
  });
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
      ])
    ).toEqual([["contains", "event:props:destination_host", ["github", "gitlab"]]]);
  });

  it("builds one filter per entry", () => {
    expect(
      buildPropertyFilters([
        { property: "plan", operator: "is", values: ["pro"] },
        { property: "ctry", operator: "is_not", values: ["US"] },
      ])
    ).toEqual([
      ["is", "event:props:plan", ["pro"]],
      ["is_not", "event:props:ctry", ["US"]],
    ]);
  });

  it("passes built-in dimensions through verbatim", () => {
    expect(
      buildPropertyFilters([
        { property: "visit:channel", operator: "is", values: ["Organic Search"] },
      ])
    ).toEqual([["is", "visit:channel", ["Organic Search"]]]);
  });

  it("does not double-prefix a fully-qualified event:props: property", () => {
    expect(
      buildPropertyFilters([{ property: "event:props:plan", values: ["pro"] }])
    ).toEqual([["is", "event:props:plan", ["pro"]]]);
  });
});

describe("assertNoShortcutOverlap", () => {
  it("passes when the filters target other dimensions", () => {
    expect(() =>
      assertNoShortcutOverlap(
        [{ property: "visit:channel", values: ["Organic Search"] }],
        { page: "/pricing", goal: "Signup" }
      )
    ).not.toThrow();
  });

  it("passes when the shortcut param is absent", () => {
    expect(() =>
      assertNoShortcutOverlap([{ property: "event:page", values: ["/docs"] }], {})
    ).not.toThrow();
  });

  it("rejects the page shortcut alongside an event:page filter", () => {
    expect(() =>
      assertNoShortcutOverlap([{ property: "event:page", values: ["/docs"] }], {
        page: "/pricing",
      })
    ).toThrow('Drop "page"');
  });

  it("rejects the goal shortcut alongside an event:goal filter", () => {
    expect(() =>
      assertNoShortcutOverlap([{ property: "event:goal", values: ["Purchase"] }], {
        goal: "Signup",
      })
    ).toThrow('Drop "goal"');
  });
});
