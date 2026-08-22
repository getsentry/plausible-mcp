import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_INFO_META_KEY } from "@modelcontextprotocol/server";

const setAttribute = vi.hoisted(() => vi.fn());

vi.mock("@sentry/cloudflare", () => ({
  getActiveSpan: () => ({ setAttribute }),
}));

import { recordMcpClientInfo } from "../src/mcp-telemetry.js";

describe("recordMcpClientInfo", () => {
  beforeEach(() => {
    setAttribute.mockClear();
  });

  it("adds modern per-request client identity to the active MCP span", () => {
    recordMcpClientInfo({
      http: {
        authInfo: {
          token: "access-token",
          clientId: "user@sentry.io",
          scopes: ["plausible:read"],
          extra: { recordMcpClientInfo: true },
        },
      },
      mcpReq: {
        envelope: {
          [CLIENT_INFO_META_KEY]: {
            name: "modern-client",
            title: "Modern Client",
            version: "1.2.3",
          },
        },
      },
    } as never);

    expect(setAttribute).toHaveBeenCalledWith("mcp.client.name", "modern-client");
    expect(setAttribute).toHaveBeenCalledWith("mcp.client.version", "1.2.3");
    expect(setAttribute).not.toHaveBeenCalledWith("mcp.client.title", expect.anything());
  });

  it("does nothing for legacy contexts without an envelope", () => {
    recordMcpClientInfo({} as never);
    expect(setAttribute).not.toHaveBeenCalled();
  });

  // The flag is opt-in rather than opt-out so an entry point that never sets it — STDIO
  // today, any endpoint added later — records nothing until it says otherwise.
  it("records nothing when an entry point does not opt in", () => {
    recordMcpClientInfo({
      http: {
        authInfo: {
          token: "plausible-key",
          clientId: "plausible-api-key",
          scopes: ["plausible:read"],
          extra: {},
        },
      },
      mcpReq: {
        envelope: {
          [CLIENT_INFO_META_KEY]: {
            name: "user@example.com",
            version: "personal-machine",
          },
        },
      },
    } as never);

    expect(setAttribute).not.toHaveBeenCalled();
  });
});
