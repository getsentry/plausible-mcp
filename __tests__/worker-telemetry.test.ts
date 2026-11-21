import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { clearCertsCache } from "../src/cf-access.js";
import instrumentedWorker from "../src/worker.js";
import { HEARTBEAT_SPAN_KEEP_RATE } from "../src/telemetry.js";
import type { Env } from "../src/env.js";
import type { JsonObject } from "../src/json.js";
import {
  exportedSpans,
  makeValidJwt,
  stubUpstream,
  toolsList,
  WORKER_ENV,
  executionContext,
} from "./worker-fixtures.js";

describe("Worker telemetry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearCertsCache();
  });

  it("keeps Sentry tool spans and recordToolIO gating on modern requests", async () => {
    clearCertsCache();
    const { jwt, jwk } = await makeValidJwt();
    const envelopes: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (url.pathname === "/cdn-cgi/access/certs") {
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      }
      if (url.hostname === "plausible.io") {
        return new Response(
          JSON.stringify({
            results: [{ dimensions: ["2026-07-30"], metrics: [10, 20, 30, 40] }],
            meta: {},
            query: {},
          }),
          { status: 200 },
        );
      }
      if (url.hostname === "sentry.example") {
        envelopes.push(await request.text());
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected fetch in test: ${request.url}`);
    });

    const { ctx, pending } = executionContext();
    const env = {
      ...WORKER_ENV,
      PLAUSIBLE_API_KEY: "shared-test-key",
      SENTRY_DSN: "https://public@sentry.example/1",
    } satisfies Env;
    const transport = new StreamableHTTPClientTransport(new URL("https://test.local/internal"), {
      requestInit: { headers: { "Cf-Access-Jwt-Assertion": jwt } },
      fetch: (url, init) => {
        const request = new Request(url, init);
        request.headers.set("Host", new URL(request.url).host);
        return instrumentedWorker.fetch(request, env, ctx);
      },
    });
    const client = new Client(
      { name: "sentry-modern-test", version: "0.0.1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );

    try {
      await client.connect(transport);
      await client.callTool({
        name: "get_timeseries",
        arguments: { site_id: "example.com", date_range: "7d" },
      });
    } finally {
      await client.close();
    }

    for (let index = 0; index < pending.length; index++) {
      await pending[index];
    }
    const recorded = envelopes.join("\n");
    const internalSpans = exportedSpans(envelopes);
    expect(internalSpans.map((span) => span["sentry.op"])).toEqual(
      expect.arrayContaining(["mcp.server", "http.server"]),
    );
    expect(internalSpans.some((span) => span.is_segment)).toBe(true);
    expect(recorded).not.toContain('"type":"transaction"');
    expect(internalSpans).toContainEqual(
      expect.objectContaining({
        "mcp.method.name": "tools/call",
        "mcp.client.name": "sentry-modern-test",
        "mcp.request.argument.site_id": '"example.com"',
      }),
    );
    expect(internalSpans.some((span) => "mcp.tool.result.content" in span)).toBe(true);
    // Positive control for the anonymous checks below: /internal does attribute the caller.
    expect(internalSpans).toContainEqual(
      expect.objectContaining({ "user.email": "user@sentry.io" }),
    );
    expect(recorded).not.toContain(jwt);
    expect(recorded).not.toContain("shared-test-key");

    envelopes.length = 0;
    pending.length = 0;
    const byokTransport = new StreamableHTTPClientTransport(
      new URL("https://test.local/mcp?subject=query-canary-456"),
      {
        requestInit: {
          headers: {
            Authorization: "Bearer private-test-key",
            // Stands in for the client-identity headers real callers send. It matches
            // none of the SDK's sensitive-key snippets, so nothing upstream filters it.
            "X-Openai-Subject": "subject-canary-123",
            "User-Agent": "ua-canary-789",
          },
        },
        fetch: (url, init) => {
          const request = new Request(url, init);
          request.headers.set("Host", new URL(request.url).host);
          return instrumentedWorker.fetch(request, env, ctx);
        },
      },
    );
    const byokClient = new Client(
      { name: "sentry-byok-test", version: "0.0.1", title: "title-canary-abc" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await byokClient.connect(byokTransport);
      await byokClient.callTool({
        name: "get_timeseries",
        arguments: { site_id: "private.example", date_range: "7d" },
      });
      // Feedback events bypass beforeSend entirely, so they exercise a different
      // redaction path than the tool call above.
      await byokClient.callTool({
        name: "send_feedback",
        arguments: {
          task: "Check weekly traffic",
          kind: "confusing",
          impact: "friction",
          description: "The error for key private-test-key was not specific enough.",
        },
      });
    } finally {
      await byokClient.close();
    }
    // A legacy client sends clientInfo through the initialize handshake, which the Sentry
    // SDK stores per transport and turns into mcp.client.* attributes on its own — a
    // different source than recordMcpClientInfo, which reads the modern _meta envelope.
    const legacyTransport = new StreamableHTTPClientTransport(new URL("https://test.local/mcp"), {
      requestInit: { headers: { Authorization: "Bearer private-test-key" } },
      fetch: (url, init) => {
        const request = new Request(url, init);
        request.headers.set("Host", new URL(request.url).host);
        return instrumentedWorker.fetch(request, env, ctx);
      },
    });
    const legacyClient = new Client({
      name: "legacy-canary@example.com",
      version: "0.0.1",
      title: "title-canary-abc",
    });
    try {
      await legacyClient.connect(legacyTransport);
      await legacyClient.callTool({
        name: "get_timeseries",
        arguments: { site_id: "private.example", date_range: "7d" },
      });
    } finally {
      await legacyClient.close();
    }
    for (let index = 0; index < pending.length; index++) {
      await pending[index];
    }
    const anonymous = envelopes.join("\n");
    const anonymousSpans = exportedSpans(envelopes);
    expect(anonymousSpans.some((span) => span["mcp.method.name"] === "tools/call")).toBe(true);
    expect(anonymous).not.toContain("mcp.request.argument.site_id");
    expect(anonymous).not.toContain('"mcp.tool.result.content":');
    expect(anonymous).not.toContain("private.example");
    expect(anonymous).not.toContain("private-test-key");
    // mcp.client.name/version are recorded on both endpoints — a client library
    // name and version identify software, not the person using it.
    expect(anonymousSpans.some((span) => span["mcp.client.name"] === "sentry-byok-test")).toBe(
      true,
    );
    // Positive control: the feedback submission really did reach the transport, so the
    // canary assertions below are checking a populated envelope rather than an empty one.
    expect(anonymous).toContain("send_feedback");
    expect(anonymous).not.toContain("subject-canary-123");
    expect(anonymous).not.toContain("x_openai_subject");
    expect(anonymous).not.toContain("query-canary-456");
    expect(anonymous).not.toContain("ua-canary-789");
    // The SDK writes mcp.client.title from the transport's own clientInfo, independently
    // of recordMcpClientInfo, so suppressing it at the source is not enough.
    expect(anonymous).not.toContain("title-canary-abc");
    // mcp.client.name is kept, but sanitizeClientAttribute replaces a value shaped like a
    // person rather than a piece of software — including on the SDK's own write path.
    expect(anonymous).not.toContain("legacy-canary@example.com");
    expect(anonymousSpans.some((span) => span["mcp.client.name"] === "[redacted]")).toBe(true);
    // The SDK derives no user.* here today, so this guards a future SDK change; the
    // stripping itself is covered by redaction.test.ts "anonymizeSpanWithoutIdentity".
    expect(
      anonymousSpans.flatMap((span) => Object.keys(span).filter((key) => key.startsWith("user."))),
    ).toEqual([]);
  });

  it("samples heartbeat spans at the keep-rate and keeps tool calls, with or without Mcp-Method", async () => {
    clearCertsCache();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const envelopes: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === "plausible.io") {
        return new Response(
          JSON.stringify({
            results: [{ dimensions: ["2026-07-30"], metrics: [10, 20, 30, 40] }],
            meta: {},
            query: {},
          }),
          { status: 200 },
        );
      }
      if (url.hostname === "sentry.example") {
        envelopes.push(await request.text());
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected fetch in test: ${request.url}`);
    });

    const { ctx, pending } = executionContext();
    const env = {
      ...WORKER_ENV,
      PLAUSIBLE_API_KEY: "shared-test-key",
      SENTRY_DSN: "https://public@sentry.example/1",
    } satisfies Env;

    // Every POST below needs Accept (or the MCP transport 406s before dispatch) and an
    // explicit Content-Length (the test runtime does not compute one for us), since
    // withMcpMethodHeader and inspectMcpRequest both key off that header.
    const mcpPost = (body: JsonObject, extraHeaders: Record<string, string> = {}): Request => {
      const bodyText = JSON.stringify(body);
      return new Request("https://test.local/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer private-test-key",
          Host: "test.local",
          "Content-Length": String(new TextEncoder().encode(bodyText).length),
          ...extraHeaders,
        },
        body: bodyText,
      });
    };

    // Sends one request, drains ctx.waitUntil, and returns the envelopes it flushed —
    // resetting both so the next request in this test starts from a clean slate.
    const sendAndFlush = async (request: Request): Promise<string[]> => {
      await (await instrumentedWorker.fetch(request, env, ctx)).text();
      for (const promise of pending) await promise;
      const flushed = [...envelopes];
      envelopes.length = 0;
      pending.length = 0;
      return flushed;
    };

    try {
      const pingEnvelope = await sendAndFlush(
        mcpPost({ jsonrpc: "2.0", id: 1, method: "ping" }, { "Mcp-Method": "ping" }),
      );
      expect(exportedSpans(pingEnvelope)).toEqual([]);

      // Legacy client: no Mcp-Method header at all — proves withMcpMethodHeader.
      const legacyPingEnvelope = await sendAndFlush(
        mcpPost({ jsonrpc: "2.0", id: 1, method: "ping" }),
      );
      expect(exportedSpans(legacyPingEnvelope)).toEqual([]);

      // Legacy client calling a real tool: still classified and sampled at 100%.
      const legacyToolEnvelope = await sendAndFlush(
        mcpPost({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "get_timeseries",
            arguments: { site_id: "example.com", date_range: "7d" },
          },
        }),
      );
      const legacyToolSpans = exportedSpans(legacyToolEnvelope);
      expect(legacyToolSpans.some((span) => span["mcp.method.name"] === "tools/call")).toBe(true);
      expect(legacyToolSpans.some((span) => span.is_segment)).toBe(true);

      // Below the keep-rate, the same legacy ping is kept: it is sampled, not dropped.
      randomSpy.mockReturnValue(HEARTBEAT_SPAN_KEEP_RATE / 2);
      const keptPingEnvelope = await sendAndFlush(
        mcpPost({ jsonrpc: "2.0", id: 2, method: "ping" }),
      );
      expect(exportedSpans(keptPingEnvelope)).toContainEqual(
        expect.objectContaining({ "mcp.method.name": "ping" }),
      );
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("reports a failure inside the MCP handler to Sentry and answers a JSON-RPC error", async () => {
    const upstream = stubUpstream();
    const { ctx, pending } = executionContext();
    const env = {
      ...WORKER_ENV,
      PLAUSIBLE_BASE_URL: "http://plausible.example",
      SENTRY_DSN: "https://public@sentry.example/1",
    } satisfies Env;
    const request = toolsList("/mcp", {
      Authorization: "Bearer key-aaaa-1111",
      Host: "test.local",
    });

    const response = await instrumentedWorker.fetch(request, env, ctx);
    for (let i = 0; i < pending.length; i++) await pending[i];

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: -32603 } });
    const events = upstream.envelopes.filter((envelope) => envelope.includes('"type":"event"'));
    expect(events.join("\n")).toContain("baseUrl must use HTTPS");
    expect(upstream.envelopes.join("\n")).not.toContain("key-aaaa-1111");
  });
});
