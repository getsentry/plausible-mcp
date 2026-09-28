import { describe, it, expect } from "vitest";
import {
  classifyMcpMethod,
  classifyMcpRequest,
  classifyRoute,
  resolveClientFamily,
  rootSampleRate,
  statusClass,
  errorDropReason,
  HEARTBEAT_SPAN_KEEP_RATE,
  type ErrorEventLike,
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

describe("classifyMcpRequest", () => {
  it("classifies heartbeat, tool, and control requests", () => {
    expect(classifyMcpRequest({ jsonrpc: "2.0", id: 1, method: "server/discover" }))
      .toEqual({ method: "server/discover", kind: "heartbeat" });
    expect(classifyMcpRequest({ jsonrpc: "2.0", id: 123, method: "ping" }))
      .toEqual({ method: "ping", kind: "heartbeat" });
    expect(classifyMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call" }))
      .toEqual({ method: "tools/call", kind: "tool_call" });
    expect(classifyMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }))
      .toEqual({ method: "tools/list", kind: "control" });
    expect(classifyMcpRequest({ method: "notifications/initialized" }))
      .toEqual({ method: "notifications/initialized", kind: "control" });
    expect(classifyMcpRequest({ method: "notifications/roots/list_changed" }))
      .toEqual({
        method: "notifications/roots/list_changed",
        kind: "control",
      });
    expect(classifyMcpRequest({ jsonrpc: "2.0", id: 2, method: "subscriptions/listen" }))
      .toEqual({ method: "subscriptions/listen", kind: "control" });
  });

  it("recognizes only the exact healthcheck initialize client", () => {
    expect(classifyMcpRequest({
      method: "initialize",
      params: { clientInfo: { name: "healthcheck" } },
    })).toEqual({ method: "initialize", kind: "heartbeat" });
    expect(classifyMcpRequest({
      method: "initialize",
      params: { clientInfo: { name: "claude-code" } },
    })).toEqual({ method: "initialize", kind: "control" });
  });

  it("bounds caller-controlled and malformed input", () => {
    expect(classifyMcpRequest({ method: "attacker-defined-method" }))
      .toEqual({ method: "other", kind: "unknown" });
    expect(classifyMcpRequest(null))
      .toEqual({ method: "unknown", kind: "unknown" });
    expect(classifyMcpRequest({ jsonrpc: "2.0", id: 1 }))
      .toEqual({ method: "unknown", kind: "unknown" });
    expect(classifyMcpRequest([{ method: "ping" }]))
      .toEqual({ method: "batch", kind: "control" });
  });
});

describe("classifyMcpMethod", () => {
  it("classifies modern Mcp-Method header values without reading a request body", () => {
    expect(classifyMcpMethod("server/discover"))
      .toEqual({ method: "server/discover", kind: "heartbeat" });
    expect(classifyMcpMethod("tools/call"))
      .toEqual({ method: "tools/call", kind: "tool_call" });
    expect(classifyMcpMethod("subscriptions/listen"))
      .toEqual({ method: "subscriptions/listen", kind: "control" });
    expect(classifyMcpMethod("caller-controlled"))
      .toEqual({ method: "other", kind: "unknown" });
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

  it("drops the parse errors the MCP transport reports for malformed POST bodies", () => {
    for (const value of [
      "Parse error: Invalid JSON",
      "Parse error: Invalid JSON-RPC message",
    ]) {
      const event: ErrorEventLike = {
        exception: {
          values: [{
            value,
            mechanism: { type: "auto.ai.mcp_server" },
          }],
        },
      };
      expect(errorDropReason(event)).toBe("mcp-body-parse-error");
    }
  });

  it("drops the raw SyntaxError the 2.1 transport reports before answering 400", () => {
    expect(errorDropReason({
      exception: {
        values: [{
          type: "SyntaxError",
          value: "Unexpected end of JSON input",
          mechanism: { type: "auto.ai.mcp_server", data: { error_type: "transport" } },
        }],
      },
    })).toBe("mcp-body-parse-error");
    // A SyntaxError from application code, not the transport, is a real bug.
    expect(errorDropReason({
      exception: {
        values: [{
          type: "SyntaxError",
          value: "Unexpected end of JSON input",
          mechanism: { type: "auto.ai.mcp_server", data: { error_type: "tool" } },
        }],
      },
    })).toBeNull();
  });

  it("keeps parse-error lookalikes not reported by the MCP server hook", () => {
    expect(errorDropReason({
      exception: {
        values: [{
          value: "Parse error: Invalid JSON",
          mechanism: { type: "generic" },
        }],
      },
    })).toBeNull();
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

describe("rootSampleRate", () => {
  it("drops untracked scanner routes outright", () => {
    for (const pathname of ["/.env", "/wp-admin/setup.php", "/"]) {
      expect(rootSampleRate({ pathname, mcpMethod: null })).toBe(0);
    }
  });

  it("drops tracked sub-paths that carry no MCP method", () => {
    for (const pathname of [
      "/mcp/actuator/heapdump",
      "/mcp/backup.tar.gz",
      "/internal/.env",
    ]) {
      expect(rootSampleRate({ pathname, mcpMethod: null })).toBe(0);
    }
  });

  it("keeps a tool call at the tracked endpoint", () => {
    expect(rootSampleRate({ pathname: "/mcp/", mcpMethod: "tools/call" })).toBe(1);
  });

  it("keeps the endpoint itself with no method header", () => {
    expect(rootSampleRate({ pathname: "/mcp", mcpMethod: null })).toBe(1);
  });

  it("drops handshake-only notifications", () => {
    for (const method of [
      "notifications/initialized",
      "notifications/roots/list_changed",
    ]) {
      expect(rootSampleRate({ pathname: "/mcp", mcpMethod: method })).toBe(0);
    }
  });

  it("samples handshake/keepalive noise down to the heartbeat keep-rate", () => {
    for (const method of ["ping", "server/discover", "tools/list", "initialize"]) {
      expect(rootSampleRate({ pathname: "/mcp", mcpMethod: method }))
        .toBe(HEARTBEAT_SPAN_KEEP_RATE);
    }
  });

  it("keeps real tool calls, reads, and unknown methods", () => {
    for (const method of ["tools/call", "resources/read", "foo/bar"]) {
      expect(rootSampleRate({ pathname: "/mcp", mcpMethod: method })).toBe(1);
    }
  });

  it("inherits the parent's decision when this span has one, even for an untracked path", () => {
    expect(rootSampleRate({ pathname: "/.env", mcpMethod: null, parentSampled: true }))
      .toBe(1);
    expect(rootSampleRate({ pathname: "/.env", mcpMethod: null, parentSampled: false }))
      .toBe(0);
  });

  it("keeps a span whose path can't be determined", () => {
    expect(rootSampleRate({ pathname: null, mcpMethod: null })).toBe(1);
  });
});
