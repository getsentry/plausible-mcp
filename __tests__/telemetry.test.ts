import { describe, it, expect } from "vitest";
import {
  classifyRoute,
  resolveClientFamily,
  statusClass,
  transactionDropReason,
  errorDropReason,
  HEARTBEAT_SPAN_KEEP_RATE,
  type ErrorEventLike,
  type TransactionLike,
} from "../src/telemetry.js";

describe("classifyRoute", () => {
  it("tracks the two real endpoints and their subpaths", () => {
    expect(classifyRoute("/mcp")).toEqual({ group: "mcp", route: "/mcp" });
    expect(classifyRoute("/mcp/")).toEqual({ group: "mcp", route: "/mcp" });
    expect(classifyRoute("/internal")).toEqual({
      group: "internal",
      route: "/internal",
    });
    expect(classifyRoute("/internal/foo")).toEqual({
      group: "internal",
      route: "/internal",
    });
  });

  it("returns null for scanner/background-radiation paths", () => {
    for (const p of ["/", "/.env", "/.git/config", "/wp-admin/admin-ajax.php", "/favicon.ico", "/nuclei.svg"]) {
      expect(classifyRoute(p)).toBeNull();
    }
  });

  it("does not treat lookalike prefixes as tracked", () => {
    expect(classifyRoute("/mcpx")).toBeNull();
    expect(classifyRoute("/internalstuff")).toBeNull();
  });
});

describe("statusClass", () => {
  it("buckets by hundreds", () => {
    expect(statusClass(200)).toBe("2xx");
    expect(statusClass(404)).toBe("4xx");
    expect(statusClass(503)).toBe("5xx");
  });
});

describe("resolveClientFamily", () => {
  it("returns unknown for a missing UA", () => {
    expect(resolveClientFamily(null)).toBe("unknown");
    expect(resolveClientFamily(undefined)).toBe("unknown");
    expect(resolveClientFamily("")).toBe("unknown");
  });

  it("buckets known clients by user-agent", () => {
    expect(resolveClientFamily("claude-code/1.2.3")).toBe("claude-code");
    expect(resolveClientFamily("Cursor/0.4")).toBe("cursor");
    expect(resolveClientFamily("codex-mcp-client/1.0")).toBe("codex");
    expect(resolveClientFamily("node")).toBe("node");
    expect(resolveClientFamily("python-httpx/0.27")).toBe("python");
    expect(resolveClientFamily("Go-http-client/2.0")).toBe("go");
  });

  it("collapses mcp-remote proxies into one bounded family regardless of self-reported name", () => {
    expect(resolveClientFamily("mcp-remote/0.1.37")).toBe("mcp-remote");
  });

  it("buckets anything unrecognized into 'other' so cardinality stays bounded", () => {
    // The whole point: a caller-controlled string like the monitor's "healthcheck"
    // or a scanner's "openclaw-bundle-mcp" can never become its own dimension value.
    expect(resolveClientFamily("healthcheck")).toBe("other");
    expect(resolveClientFamily("openclaw-bundle-mcp")).toBe("other");
    expect(resolveClientFamily("some-random-agent/9")).toBe("other");
  });
});

describe("errorDropReason", () => {
  it("drops the expected MCP 406 raised for a GET without SSE support", () => {
    const event: ErrorEventLike = {
      exception: {
        values: [{
          value: "Not Acceptable: Client must accept text/event-stream",
          mechanism: {
            type: "auto.ai.mcp_server",
            data: { error_type: "transport" },
          },
        }],
      },
    };

    expect(errorDropReason(event)).toBe("mcp-get-without-sse-accept");
  });

  it("keeps other transport and application errors", () => {
    expect(errorDropReason({
      exception: {
        values: [{
          value: "Unexpected transport failure",
          mechanism: {
            type: "auto.ai.mcp_server",
            data: { error_type: "transport" },
          },
        }],
      },
    })).toBeNull();
    expect(errorDropReason({
      exception: {
        values: [{ value: "Not Acceptable: Client must accept text/event-stream" }],
      },
    })).toBeNull();
  });
});

describe("transactionDropReason", () => {
  const mcpTx = (
    method: string,
    client?: string,
    url = "https://plausible-mcp.sentry.dev/mcp",
  ): TransactionLike => ({
    transaction: "POST /mcp",
    request: { url },
    contexts: { trace: { op: "http.server" } },
    spans: [
      {
        op: "mcp.server",
        description: method,
        data: {
          "mcp.method.name": method,
          ...(client ? { "mcp.client.name": client } : {}),
        },
      },
    ],
  });

  it("drops untracked scanner routes outright", () => {
    const event: TransactionLike = {
      transaction: "GET /.env",
      request: { url: "https://plausible-mcp.sentry.dev/.env" },
    };
    expect(transactionDropReason(event, 0.5)).toBe("untracked-route");
    // Even with a keep-roll, an untracked route is never kept.
    expect(transactionDropReason(event, 0)).toBe("untracked-route");
  });

  it("keeps real tool calls regardless of the sampling roll", () => {
    const event = mcpTx("tools/call");
    expect(transactionDropReason(event, 0)).toBeNull();
    expect(transactionDropReason(event, 0.999)).toBeNull();
  });

  it("samples ping down to the heartbeat keep-rate", () => {
    const event = mcpTx("ping");
    // Above the keep threshold -> dropped (the common case).
    expect(transactionDropReason(event, HEARTBEAT_SPAN_KEEP_RATE)).toBe("ping");
    expect(transactionDropReason(event, 0.9)).toBe("ping");
    // Inside the kept fraction -> retained as a heartbeat sample.
    expect(transactionDropReason(event, 0)).toBeNull();
  });

  it("samples the healthcheck monitor's initialize, but keeps real initialize", () => {
    const health = mcpTx("initialize", "healthcheck");
    expect(transactionDropReason(health, 0.5)).toBe("healthcheck-initialize");
    expect(transactionDropReason(health, 0)).toBeNull(); // heartbeat sample

    const real = mcpTx("initialize", "claude-code");
    expect(transactionDropReason(real, 0.5)).toBeNull();
    const anon = mcpTx("initialize"); // no client name at all
    expect(transactionDropReason(anon, 0.5)).toBeNull();
  });

  it("falls back to the transaction name when request.url is absent", () => {
    const event: TransactionLike = { transaction: "GET /robots.txt" };
    expect(transactionDropReason(event, 0.5)).toBe("untracked-route");
  });

  it("keeps a transaction whose path can't be determined", () => {
    expect(transactionDropReason({}, 0.5)).toBeNull();
  });

  it("reads mcp attributes off the root span when mcp.server is the root", () => {
    const event: TransactionLike = {
      transaction: "POST /mcp",
      request: { url: "https://plausible-mcp.sentry.dev/mcp" },
      contexts: {
        trace: { op: "mcp.server", data: { "mcp.method.name": "ping" } },
      },
    };
    expect(transactionDropReason(event, 0.9)).toBe("ping");
  });
});
