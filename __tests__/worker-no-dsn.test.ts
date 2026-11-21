// Its own file: a Sentry client that an earlier test initialized stays current for the rest
// of a file, and a request without a DSN would report through it.
import { expect, it, vi } from "vitest";
import instrumentedWorker from "../src/worker.js";
import type { Env } from "../src/env.js";

// Regression (ea7490d): forks of this public repo once reported into our Sentry project.
it("sends nothing to Sentry when no DSN is configured, even for a captured failure", async () => {
  const sent: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    sent.push(new Request(input, init).url);
    return new Response(null, { status: 200 });
  });
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  // An HTTP Plausible base URL makes server creation throw, which is reported when Sentry runs.
  const env = { MCP_ALLOWED_HOSTNAMES: "test.local", PLAUSIBLE_BASE_URL: "http://plausible.example" } satisfies Env;
  const request = new Request("https://test.local/mcp", {
    method: "POST",
    headers: {
      Host: "test.local",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer key-aaaa-1111",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  const response = await instrumentedWorker.fetch!(request, env, ctx);
  for (let i = 0; i < pending.length; i++) await pending[i];

  expect(response.status).toBe(500);
  expect(sent).toEqual([]);
});
