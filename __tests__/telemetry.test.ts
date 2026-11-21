import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { UnsupportedProtocolVersionError } from "@modelcontextprotocol/server";
import {
  classifyMcpMethod,
  classifyMcpRequest,
  classifyRoute,
  resolveClientFamily,
  rootSampleRate,
  statusClass,
  errorDropReason,
  isMcpClientRejection,
  isKnownMcpMethod,
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
    for (const p of [
      "/",
      "/.env",
      "/.git/config",
      "/wp-admin/admin-ajax.php",
      "/favicon.ico",
      "/nuclei.svg",
    ]) {
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
    expect(classifyMcpRequest({ jsonrpc: "2.0", id: 1, method: "server/discover" })).toEqual({
      method: "server/discover",
      kind: "heartbeat",
    });
    expect(classifyMcpRequest({ jsonrpc: "2.0", id: 123, method: "ping" })).toEqual({
      method: "ping",
      kind: "heartbeat",
    });
    expect(classifyMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call" })).toEqual({
      method: "tools/call",
      kind: "tool_call",
    });
    expect(classifyMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toEqual({
      method: "tools/list",
      kind: "control",
    });
    expect(classifyMcpRequest({ method: "notifications/initialized" })).toEqual({
      method: "notifications/initialized",
      kind: "control",
    });
    expect(classifyMcpRequest({ method: "notifications/roots/list_changed" })).toEqual({
      method: "notifications/roots/list_changed",
      kind: "control",
    });
    expect(classifyMcpRequest({ jsonrpc: "2.0", id: 2, method: "subscriptions/listen" })).toEqual({
      method: "subscriptions/listen",
      kind: "control",
    });
  });

  it("recognizes only the exact healthcheck initialize client", () => {
    expect(
      classifyMcpRequest({
        method: "initialize",
        params: { clientInfo: { name: "healthcheck" } },
      }),
    ).toEqual({ method: "initialize", kind: "heartbeat" });
    expect(
      classifyMcpRequest({
        method: "initialize",
        params: { clientInfo: { name: "claude-code" } },
      }),
    ).toEqual({ method: "initialize", kind: "control" });
  });

  it("bounds malformed input", () => {
    expect(classifyMcpRequest(null)).toEqual({ method: "unknown", kind: "unknown" });
    expect(classifyMcpRequest({ jsonrpc: "2.0", id: 1 })).toEqual({
      method: "unknown",
      kind: "unknown",
    });
    expect(classifyMcpRequest([{ method: "ping" }])).toEqual({ method: "batch", kind: "control" });
  });
});

// The worker classifies the Mcp-Method header with classifyMcpMethod and a legacy body with
// classifyMcpRequest; both must give the same bounded values for any caller-sent name.
describe("classifyMcpMethod", () => {
  it("never echoes a method name it does not know, from a header or a body", () => {
    const method = fc.oneof(
      fc.string({ minLength: 1 }),
      fc.constantFrom("ping", "tools/call", "server/discover", "tools/list"),
    );
    fc.assert(
      fc.property(method, (name) => {
        const fromHeader = classifyMcpMethod(name);
        expect(fromHeader.method).toBe(isKnownMcpMethod(name) ? name : "other");
        expect(["heartbeat", "tool_call", "control", "unknown"]).toContain(fromHeader.kind);
        expect(fromHeader.kind === "unknown").toBe(fromHeader.method === "other");
        expect(classifyMcpRequest({ jsonrpc: "2.0", id: 1, method: name })).toEqual(fromHeader);
      }),
    );
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
    expect(resolveClientFamily("mcp-remote/0.1.37")).toBe("mcp-remote");
    expect(resolveClientFamily("Claude-User")).toBe("claude");
    expect(resolveClientFamily("openai-mcp/1.0")).toBe("openai");
    expect(resolveClientFamily("Java-http-client/21")).toBe("java");
  });

  it("buckets any user agent into one of the documented families", () => {
    const families = [
      "claude-code",
      "cursor",
      "codex",
      "mcp-remote",
      "claude",
      "openai",
      "go",
      "java",
      "python",
      "node",
      "other",
      "unknown",
    ];
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: null }), (userAgent) => {
        expect(families).toContain(resolveClientFamily(userAgent));
      }),
    );
    // A caller-chosen name like the monitor's "healthcheck" never becomes its own value.
    expect(resolveClientFamily("healthcheck")).toBe("other");
  });
});

describe("isMcpClientRejection", () => {
  it.each([
    new UnsupportedProtocolVersionError({ supported: ["2026-07-28"], requested: "1999-01-01" }),
    new Error("Rejected inbound request (H3): MCP-Method header does not match the body"),
    new Error("Rejected 2025-era request on a modern-only endpoint (L1): unsupported"),
    new Error("Unsupported Media Type: Content-Type must be application/json"),
  ])("skips the client rejection %s", (error) => {
    expect(isMcpClientRejection(error)).toBe(true);
  });

  it.each([
    new Error("subscriptions/listen refused: subscription limit reached (1024)"),
    new Error("Response for request ID 7 is undeliverable: per-request stream is disconnected"),
    new TypeError("Cannot read properties of undefined"),
  ])("captures the server fault %s", (error) => {
    expect(isMcpClientRejection(error)).toBe(false);
  });
});

describe("errorDropReason", () => {
  it("drops the expected MCP 406 raised for a GET without SSE support", () => {
    const event: ErrorEventLike = {
      exception: {
        values: [
          {
            value: "Not Acceptable: Client must accept text/event-stream",
            mechanism: {
              type: "auto.ai.mcp_server",
              data: { error_type: "transport" },
            },
          },
        ],
      },
    };

    expect(errorDropReason(event)).toBe("mcp-get-without-sse-accept");
  });

  it("drops the parse errors the MCP transport reports for malformed POST bodies", () => {
    for (const value of ["Parse error: Invalid JSON", "Parse error: Invalid JSON-RPC message"]) {
      const event: ErrorEventLike = {
        exception: {
          values: [
            {
              value,
              mechanism: { type: "auto.ai.mcp_server" },
            },
          ],
        },
      };
      expect(errorDropReason(event)).toBe("mcp-body-parse-error");
    }
  });

  it("drops the raw SyntaxError the 2.1 transport reports before answering 400", () => {
    expect(
      errorDropReason({
        exception: {
          values: [
            {
              type: "SyntaxError",
              value: "Unexpected end of JSON input",
              mechanism: { type: "auto.ai.mcp_server", data: { error_type: "transport" } },
            },
          ],
        },
      }),
    ).toBe("mcp-body-parse-error");
    // A SyntaxError from application code, not the transport, is a real bug.
    expect(
      errorDropReason({
        exception: {
          values: [
            {
              type: "SyntaxError",
              value: "Unexpected end of JSON input",
              mechanism: { type: "auto.ai.mcp_server", data: { error_type: "tool" } },
            },
          ],
        },
      }),
    ).toBeNull();
  });

  it("keeps parse-error lookalikes not reported by the MCP server hook", () => {
    expect(
      errorDropReason({
        exception: {
          values: [
            {
              value: "Parse error: Invalid JSON",
              mechanism: { type: "generic" },
            },
          ],
        },
      }),
    ).toBeNull();
  });

  it("keeps other transport and application errors", () => {
    expect(
      errorDropReason({
        exception: {
          values: [
            {
              value: "Unexpected transport failure",
              mechanism: {
                type: "auto.ai.mcp_server",
                data: { error_type: "transport" },
              },
            },
          ],
        },
      }),
    ).toBeNull();
    expect(
      errorDropReason({
        exception: {
          values: [{ value: "Not Acceptable: Client must accept text/event-stream" }],
        },
      }),
    ).toBeNull();
  });
});

describe("rootSampleRate", () => {
  it("drops untracked scanner routes outright", () => {
    for (const pathname of ["/.env", "/wp-admin/setup.php", "/"]) {
      expect(rootSampleRate({ pathname, mcpMethod: null })).toBe(0);
    }
  });

  it("drops tracked sub-paths that carry no MCP method", () => {
    for (const pathname of ["/mcp/actuator/heapdump", "/mcp/backup.tar.gz", "/internal/.env"]) {
      expect(rootSampleRate({ pathname, mcpMethod: null })).toBe(0);
    }
  });

  it("keeps the endpoint itself with no method header", () => {
    expect(rootSampleRate({ pathname: "/mcp", mcpMethod: null })).toBe(1);
    expect(rootSampleRate({ pathname: "/mcp", mcpMethod: null, requestMethod: "POST" })).toBe(1);
  });

  it("samples GET probes for an event stream down to the heartbeat keep-rate", () => {
    expect(rootSampleRate({ pathname: "/mcp", mcpMethod: null, requestMethod: "GET" })).toBe(
      HEARTBEAT_SPAN_KEEP_RATE,
    );
  });

  it("drops handshake-only notifications", () => {
    for (const method of ["notifications/initialized", "notifications/roots/list_changed"]) {
      expect(rootSampleRate({ pathname: "/mcp", mcpMethod: method })).toBe(0);
    }
  });

  it("samples handshake/keepalive noise down to the heartbeat keep-rate", () => {
    for (const method of [
      "ping",
      "server/discover",
      "tools/list",
      "initialize",
      "resources/list",
      "resources/templates/list",
      "subscriptions/listen",
    ]) {
      expect(rootSampleRate({ pathname: "/mcp", mcpMethod: method })).toBe(
        HEARTBEAT_SPAN_KEEP_RATE,
      );
    }
  });

  it("keeps real tool calls, reads, and unknown methods", () => {
    for (const method of ["tools/call", "resources/read", "foo/bar"]) {
      expect(rootSampleRate({ pathname: "/mcp", mcpMethod: method })).toBe(1);
    }
  });

  it("inherits the parent's decision when this span has one, even for an untracked path", () => {
    expect(rootSampleRate({ pathname: "/.env", mcpMethod: null, parentSampled: true })).toBe(1);
    expect(rootSampleRate({ pathname: "/.env", mcpMethod: null, parentSampled: false })).toBe(0);
  });

  it("keeps a span whose path can't be determined", () => {
    expect(rootSampleRate({ pathname: null, mcpMethod: null })).toBe(1);
  });
});
