import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as Sentry from "@sentry/cloudflare";
import { CLIENT_INFO_META_KEY } from "@modelcontextprotocol/server";
import { recordMcpClientInfo } from "../src/mcp-telemetry.js";
import { captureSentry } from "./harness.js";

let sentry: ReturnType<typeof captureSentry>;
beforeAll(() => {
  sentry = captureSentry();
});
beforeEach(() => {
  sentry.spans.length = 0;
});

/** Attributes Sentry exports for a span in which the tool recorded the given request context. */
async function exportedSpan(optIn: boolean) {
  Sentry.startSpan({ name: "tools/call get_timeseries" }, () =>
    recordMcpClientInfo({
      http: {
        authInfo: {
          token: "access-token",
          clientId: "user@example.com",
          scopes: ["plausible:read"],
          extra: optIn ? { recordMcpClientInfo: true } : {},
        },
      },
      mcpReq: {
        envelope: {
          [CLIENT_INFO_META_KEY]: {
            name: "modern-client",
            title: "Ada's Laptop",
            version: "1.2.3",
          },
        },
      },
    } as never),
  );
  await sentry.flush();
  expect(sentry.spans).toHaveLength(1);
  return sentry.spans[0];
}

describe("recordMcpClientInfo", () => {
  it("exports the per-request client name and version, never the title, when the endpoint opts in", async () => {
    const span = await exportedSpan(true);

    expect(span).toMatchObject({
      "mcp.client.name": "modern-client",
      "mcp.client.version": "1.2.3",
    });
    expect(JSON.stringify(sentry.envelopes)).not.toContain("Ada's Laptop");
  });

  // Opt-in rather than opt-out, so an entry point that never sets the flag (STDIO today, any
  // endpoint added later) records nothing until it says otherwise.
  it("exports no client identity when the endpoint does not opt in", async () => {
    const span = await exportedSpan(false);

    expect(Object.keys(span).filter((key) => key.startsWith("mcp.client."))).toEqual([]);
  });
});
