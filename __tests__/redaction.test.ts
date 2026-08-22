import { describe, it, expect } from "vitest";
import {
  anonymizeEventWithoutEmail,
  stripHeaderAttributes,
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

describe("stripHeaderAttributes", () => {
  it("removes request and response header attributes and leaves other keys alone", () => {
    const data: Record<string, unknown> = {
      "http.request.header.x_openai_subject": "user-123",
      "http.response.header.set_cookie": "id=1",
      "mcp.tool.name": "get_breakdown",
    };

    stripHeaderAttributes(data);

    expect(data).toEqual({ "mcp.tool.name": "get_breakdown" });
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
