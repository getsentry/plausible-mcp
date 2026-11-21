import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  anonymizeEventWithoutEmail,
  anonymizeSpanWithoutIdentity,
  sanitizeClientAttribute,
  stripRequestAttributes,
  stripUrlQuery,
  type RedactableEvent,
  type SentryAttributes,
} from "../src/redaction.js";
import { z } from "zod";

describe("anonymizeEventWithoutEmail (BYOK privacy guardrail)", () => {
  it("strips an IP-only user (anonymous / BYOK event)", () => {
    const event: RedactableEvent = { user: { ip_address: "2a06:98c0::1" } };
    anonymizeEventWithoutEmail(event);
    expect(event.user).toEqual({ ip_address: null });
  });

  it("strips tool input from an anonymous /mcp error event", () => {
    const event: RedactableEvent = {
      request: {
        data: {
          method: "tools/call",
          params: { arguments: { site_id: "private.example" } },
        },
      },
    };

    anonymizeEventWithoutEmail(event);

    expect(event.request?.data).toBeUndefined();
  });

  it("anonymizes when there is no user at all", () => {
    const event: RedactableEvent = {};
    anonymizeEventWithoutEmail(event);
    expect(event.user).toEqual({ ip_address: null });
  });

  it("leaves an authenticated (/internal) user untouched", () => {
    const event: RedactableEvent = {
      user: { email: "user@sentry.io", ip_address: "2a06:98c0::1" },
    };
    anonymizeEventWithoutEmail(event);
    expect(event.user).toEqual({
      email: "user@sentry.io",
      ip_address: "2a06:98c0::1",
    });
  });

  it("keeps tool input for an authenticated /internal event", () => {
    const data = { method: "tools/call", params: { arguments: { site_id: "example.com" } } };
    const event: RedactableEvent = {
      user: { email: "user@sentry.io" },
      request: { data },
    };

    anonymizeEventWithoutEmail(event);

    expect(event.request?.data).toBe(data);
  });

  it("redacts bearer and Access credentials on anonymous and authenticated events", () => {
    const anonymous: RedactableEvent = {
      request: {
        headers: {
          authorization: "Bearer plausible-key",
          "content-type": "application/json",
        },
      },
    };
    const authenticated: RedactableEvent = {
      user: { email: "user@sentry.io" },
      request: {
        headers: {
          "Cf-Access-Jwt-Assertion": "signed-access-jwt",
          Cookie: "CF_Authorization=access-cookie",
        },
      },
    };

    anonymizeEventWithoutEmail(anonymous);
    anonymizeEventWithoutEmail(authenticated);

    expect(anonymous.request?.headers).toEqual({
      authorization: "[Filtered]",
      "content-type": "application/json",
    });
    expect(authenticated.request?.headers).toEqual({
      "Cf-Access-Jwt-Assertion": "[Filtered]",
      Cookie: "[Filtered]",
    });
  });

  it("treats an empty-string email as anonymous", () => {
    const event: RedactableEvent = { user: { email: "", ip_address: "1.2.3.4" } };
    anonymizeEventWithoutEmail(event);
    expect(event.user).toEqual({ ip_address: null });
  });

  it("keeps a service-token identity (username, no email) and its tool input", () => {
    const data = { method: "tools/call", params: { arguments: { site_id: "example.com" } } };
    const event: RedactableEvent = {
      user: { username: "svc123.access" },
      request: { data },
    };

    anonymizeEventWithoutEmail(event);

    expect(event.user).toEqual({ username: "svc123.access" });
    expect(event.request?.data).toBe(data);
  });

  it("treats an empty-string username as anonymous", () => {
    const event: RedactableEvent = { user: { username: "", ip_address: "1.2.3.4" } };
    anonymizeEventWithoutEmail(event);
    expect(event.user).toEqual({ ip_address: null });
  });

  it("strips header span attributes even on an authenticated event", () => {
    const authenticated: RedactableEvent = {
      user: { email: "user@sentry.io" },
      contexts: {
        trace: {
          data: {
            "http.request.header.x_openai_subject": "user-123",
            "mcp.client.name": "claude",
          },
        },
      },
      spans: [{ data: { "http.response.header.set_cookie": "id=1" } }],
    };

    anonymizeEventWithoutEmail(authenticated);

    expect(authenticated.contexts?.trace?.data).toEqual({ "mcp.client.name": "claude" });
    expect(authenticated.spans?.[0].data).toEqual({});
  });
});

describe("stripRequestAttributes", () => {
  it("removes header, user-agent and query attributes and leaves other keys alone", () => {
    const data: SentryAttributes = {
      "http.request.header.x_openai_subject": "user-123",
      "http.response.header.set_cookie": "id=1",
      "user_agent.original": "SomeClient/1.0 (user@example.com)",
      "mcp.client.title": "Ada's Work Laptop",
      "mcp.client.name": "some-client",
      "mcp.client.version": "1.2.3",
      "url.query": "?subject=user@example.com",
      "url.full": "https://example.com/mcp?subject=user@example.com",
      "url.path": "/mcp",
      "mcp.tool.name": "get_breakdown",
    };

    stripRequestAttributes(data);

    expect(data).toEqual({
      "url.full": "https://example.com/mcp",
      "url.path": "/mcp",
      "mcp.client.name": "some-client",
      "mcp.client.version": "1.2.3",
      "mcp.tool.name": "get_breakdown",
    });
  });

  it("cuts any URL at its first ? or #, and cutting again changes nothing", () => {
    fc.assert(
      fc.property(fc.webUrl({ withQueryParameters: true, withFragments: true }), (url) => {
        const stripped = stripUrlQuery(url);
        expect(stripped).toBe(url.split(/[?#]/)[0]);
        expect(stripped).not.toMatch(/[?#]/);
        expect(stripUrlQuery(stripped)).toBe(stripped);
      }),
    );
  });

  // Any caller-controlled attribute map: no header, user agent, title or query survives,
  // and stripping twice gives the same result as stripping once.
  it("removes every caller-controlled request attribute from any attribute map", () => {
    const key = fc.oneof(
      fc
        .constantFrom("http.request.header.", "http.response.header.", "HTTP.Request.Header.")
        .chain((prefix) => fc.string({ minLength: 1, maxLength: 12 }).map((name) => prefix + name)),
      fc.constantFrom(
        "user_agent.original",
        "mcp.client.title",
        "url.query",
        "url.path",
        "mcp.tool.name",
      ),
      fc.string({ maxLength: 12 }),
    );
    const value = fc.oneof(fc.string(), fc.webUrl({ withQueryParameters: true }), fc.integer());
    fc.assert(
      fc.property(
        fc.dictionary(key, value),
        fc.option(fc.webUrl({ withQueryParameters: true }), { nil: undefined }),
        (input, url) => {
          const data: SentryAttributes = { ...input, ...(url && { "url.full": url }) };
          stripRequestAttributes(data);

          for (const k of Object.keys(data)) {
            expect(k.toLowerCase()).not.toMatch(/^http\.(request|response)\.header\./);
          }
          for (const k of ["user_agent.original", "mcp.client.title", "url.query"]) {
            expect(data).not.toHaveProperty(k);
          }
          expect(z.string().safeParse(data["url.full"]).data ?? "").not.toMatch(/[?#]/);
          const again = { ...data };
          stripRequestAttributes(again);
          expect(again).toEqual(data);
        },
      ),
    );
  });
});

describe("sanitizeClientAttribute", () => {
  it.each([
    ["claude-code", "claude-code"],
    ["Claude Desktop", "Claude Desktop"],
    ["mcp-remote", "mcp-remote"],
    ["io.modelcontextprotocol.inspector", "io.modelcontextprotocol.inspector"],
    ["com.example.client", "com.example.client"],
    ["1.2.3-beta.4", "1.2.3-beta.4"],
    ["  cursor-vscode  ", "cursor-vscode"],
    ["@scope/pkg", "@scope/pkg"],
    ["org/client", "org/client"],
  ])("passes through the software identifier %j", (value, expected) => {
    expect(sanitizeClientAttribute(value)).toBe(expected);
  });

  it.each([
    ["ada@example.com"],
    ["client (ada.lovelace@corp.example.com)"],
    ["https://corp.example.com/mcp"],
    ["file:///Users/ada/src/client"],
    ["/Users/ada/src/client"],
    ["~/src/client"],
    ["client C:\\Users\\Ada\\app"],
    ["3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
    ["session-9f86d081884c7d65"],
    ["0.0.0-dev+/Users/ada/src"],
    ["ada-laptop.internal"],
    ["runner.corp.example.com"],
    ["client on ada-laptop.local now"],
  ])("redacts the identity shape in %j", (value) => {
    expect(sanitizeClientAttribute(value)).toBe("[redacted]");
  });

  it("drops an empty or whitespace-only value", () => {
    expect(sanitizeClientAttribute("")).toBeUndefined();
    expect(sanitizeClientAttribute("   ")).toBeUndefined();
  });

  it("truncates rather than redacts a long but clean name", () => {
    const value = "a".repeat(100);
    expect(sanitizeClientAttribute(value)).toBe("a".repeat(64));
  });

  // Truncation can end a value on an identity shape the full value did not have: 47 letters
  // then "-0123456789abcdef" then "zzz" ends in a 16-hex session id once cut to 64 characters.
  it.each([["x".repeat(47) + "-0123456789abcdef" + "zzz"], ["y".repeat(60) + ".comet"]])(
    "redacts an identity shape that truncation exposes in %j",
    (value) => {
      expect(sanitizeClientAttribute(value)).toBe("[redacted]");
    },
  );

  it("returns at most 64 characters, and the same value when applied to its own output", () => {
    const identityParts = fc.oneof(
      fc.string(),
      fc.emailAddress(),
      fc
        .string({
          unit: fc.constantFrom(..."0123456789abcdef".split("")),
          minLength: 16,
          maxLength: 20,
        })
        .map((hex) => `-${hex}1`),
      fc.constantFrom(".com", ".internal", "/Users/ada", " ", "-", "@"),
    );
    fc.assert(
      // A clean lead of 30-63 characters puts the 64-character cut inside the shaped tail.
      fc.property(
        fc.string({ unit: fc.constantFrom(..."abcxyz".split("")), minLength: 30, maxLength: 63 }),
        fc.array(identityParts, { maxLength: 8 }),
        (lead, parts) => {
          const value = lead + parts.join("");
          const once = sanitizeClientAttribute(value);
          if (once === undefined) return;
          expect(once.length).toBeLessThanOrEqual(64);
          expect(sanitizeClientAttribute(once)).toBe(once);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("never stores an email address it was given, wherever it sits", () => {
    fc.assert(
      fc.property(fc.string(), fc.emailAddress(), fc.string(), (before, email, after) => {
        expect(sanitizeClientAttribute(`${before}${email} ${after}`) ?? "").not.toContain(email);
      }),
    );
  });
});

describe("stripRequestAttributes (client identifiers)", () => {
  it("sanitizes the client attributes the SDK writes from a legacy handshake", () => {
    const data: SentryAttributes = {
      "mcp.client.name": "ada@example.com",
      "mcp.client.version": "0.0.0-dev+/Users/ada/src",
      "mcp.tool.name": "get_breakdown",
    };

    stripRequestAttributes(data);

    expect(data).toEqual({
      "mcp.client.name": "[redacted]",
      "mcp.client.version": "[redacted]",
      "mcp.tool.name": "get_breakdown",
    });
  });

  it("drops a client attribute that is empty after trimming", () => {
    const data: SentryAttributes = { "mcp.client.name": "  " };

    stripRequestAttributes(data);

    expect(data).not.toHaveProperty("mcp.client.name");
  });
});

describe("anonymizeSpanWithoutIdentity (streamed segment spans)", () => {
  it("removes SDK-derived user attributes from an anonymous /mcp segment", () => {
    const span = {
      is_segment: true,
      attributes: {
        "sentry.op": "http.server",
        "user.ip_address": "2a06:98c0::1",
        "user.geo.country_code": "DE",
      },
    };
    anonymizeSpanWithoutIdentity(span);
    expect(Object.keys(span.attributes)).toEqual(["sentry.op"]);
  });

  it("keeps an /internal person identified by email", () => {
    const span = {
      is_segment: true,
      attributes: { "user.email": "user.name@sentry.io", "user.ip_address": "1.2.3.4" },
    };
    anonymizeSpanWithoutIdentity(span);
    expect(span.attributes).toEqual({
      "user.email": "user.name@sentry.io",
      "user.ip_address": "1.2.3.4",
    });
  });

  it("keeps an /internal service token identified by username only, like the error path", () => {
    const span = {
      is_segment: true,
      attributes: { "user.username": "svc123.access" },
    };
    anonymizeSpanWithoutIdentity(span);
    expect(span.attributes).toEqual({ "user.username": "svc123.access" });
  });

  it("treats an empty identity string as anonymous", () => {
    const span = { is_segment: true, attributes: { "user.email": "", "user.username": "" } };
    anonymizeSpanWithoutIdentity(span);
    expect(span.attributes).toEqual({});
  });

  it("still strips caller-controlled request attributes on a non-segment span", () => {
    const span = {
      is_segment: false,
      attributes: { "http.request.header.authorization": "Bearer x", "user.ip_address": "1.2.3.4" },
    };
    anonymizeSpanWithoutIdentity(span);
    expect(span.attributes).toEqual({ "user.ip_address": "1.2.3.4" });
  });
});

describe("anonymizeEventWithoutEmail (request headers)", () => {
  it("filters every credential header, whatever its case, and keeps the others", () => {
    const credential = fc
      .tuple(
        fc.constantFrom(
          "authorization",
          "cookie",
          "cf-access-jwt-assertion",
          "cf-access-client-id",
          "proxy-authorization",
          "set-cookie",
        ),
        fc.boolean(),
      )
      .map(([name, upper]) => (upper ? name.toUpperCase() : name));
    const other = fc.constantFrom("accept", "content-type", "mcp-method", "x-request-id");
    fc.assert(
      fc.property(
        fc.dictionary(credential, fc.string()),
        fc.dictionary(other, fc.string()),
        fc.boolean(),
        (secrets, rest, identified) => {
          const headers = { ...rest, ...secrets };
          const event: RedactableEvent = {
            user: identified ? { email: "user@sentry.io" } : { ip_address: "203.0.113.9" },
            request: { headers: { ...headers } },
          };

          anonymizeEventWithoutEmail(event);

          for (const name of Object.keys(secrets))
            expect(event.request?.headers?.[name]).toBe("[Filtered]");
          for (const [name, value] of Object.entries(rest))
            expect(event.request?.headers?.[name]).toBe(value);
        },
      ),
    );
  });
});
