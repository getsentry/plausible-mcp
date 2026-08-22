import { describe, it, expect } from "vitest";
import {
  anonymizeEventWithoutEmail,
  sanitizeClientAttribute,
  stripRequestAttributes,
  type RedactableEvent,
} from "../src/redaction.js";

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

  it("keeps mcp.client.name and mcp.client.version on an anonymous event", () => {
    const anonymous: RedactableEvent = {
      contexts: {
        trace: {
          data: {
            "mcp.client.name": "claude-code",
            "mcp.client.version": "1.2.3",
            "mcp.method.name": "tools/call",
          },
        },
      },
    };

    anonymizeEventWithoutEmail(anonymous);

    expect(anonymous.contexts?.trace?.data).toEqual({
      "mcp.client.name": "claude-code",
      "mcp.client.version": "1.2.3",
      "mcp.method.name": "tools/call",
    });
  });

  it("treats an empty-string email as anonymous", () => {
    const event: RedactableEvent = { user: { email: "", ip_address: "1.2.3.4" } };
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
    const data: Record<string, unknown> = {
      "http.request.header.x_openai_subject": "user-123",
      "http.response.header.set_cookie": "id=1",
      "user_agent.original": "SomeClient/1.0 (user@example.com)",
      "mcp.client.title": "Ada's Work Laptop",
      "mcp.client.name": "some-client",
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
      "mcp.tool.name": "get_breakdown",
    });
  });

  it("leaves a url with no query or fragment unchanged", () => {
    const data: Record<string, unknown> = { "url.full": "https://example.com/mcp" };

    stripRequestAttributes(data);

    expect(data["url.full"]).toBe("https://example.com/mcp");
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
});

describe("stripRequestAttributes (client identifiers)", () => {
  it("sanitizes the client attributes the SDK writes from a legacy handshake", () => {
    const data: Record<string, unknown> = {
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
    const data: Record<string, unknown> = { "mcp.client.name": "  " };

    stripRequestAttributes(data);

    expect(data).not.toHaveProperty("mcp.client.name");
  });
});

describe("anonymizeEventWithoutEmail (feedback events)", () => {
  it("strips user and request data from a feedback-typed event", () => {
    const event: RedactableEvent & { type?: string } = {
      type: "feedback",
      user: { ip_address: "2a06:98c0::1" },
      request: { data: { message: "it broke" } },
    };

    anonymizeEventWithoutEmail(event);

    expect(event.user).toEqual({ ip_address: null });
    expect(event.request?.data).toBeUndefined();
  });
});
