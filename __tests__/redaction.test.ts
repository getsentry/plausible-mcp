import { describe, it, expect } from "vitest";
import {
  anonymizeEventWithoutEmail,
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

  it("treats an empty-string email as anonymous", () => {
    const event: RedactableEvent = { user: { email: "", ip_address: "1.2.3.4" } };
    anonymizeEventWithoutEmail(event);
    expect(event.user).toEqual({ ip_address: null });
  });
});
