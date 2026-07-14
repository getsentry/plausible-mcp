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

  it("treats an empty-string email as anonymous", () => {
    const event: RedactableEvent = { user: { email: "", ip_address: "1.2.3.4" } };
    anonymizeEventWithoutEmail(event);
    expect(event.user).toEqual({ ip_address: null });
  });
});
