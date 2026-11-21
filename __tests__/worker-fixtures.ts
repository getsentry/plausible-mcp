// Shared by the Worker and Cloudflare Access tests: the Worker env, signed Access JWTs, and
// stand-ins for the network the Worker reaches.
import { vi } from "vitest";
import { z } from "zod";
import type { JsonObject } from "../src/json.js";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { AccessConfig } from "../src/cf-access.js";
import { workerHandler } from "../src/worker.js";
import type { Env } from "../src/env.js";

export const TEAM_DOMAIN = "https://sentry.cloudflareaccess.com";
export const AUD = "test-audience-tag";

export const config: AccessConfig = {
  teamDomain: TEAM_DOMAIN,
  aud: AUD,
  allowedEmailDomains: ["sentry.io"],
};

export const WORKER_ENV = {
  CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  CF_ACCESS_AUD: AUD,
  MCP_ALLOWED_HOSTNAMES: "test.local",
} satisfies Env;

export function workerFetch(request: Request, env: Env = WORKER_ENV): Promise<Response> {
  if (!request.headers.has("Host")) {
    request.headers.set("Host", new URL(request.url).host);
  }
  return workerHandler.fetch(request, env, executionContext().ctx);
}

/** An ExecutionContext that keeps waitUntil promises, so a test can wait for Sentry's flush. */
export function executionContext() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
    passThroughOnException() {},
    props: {},
  } satisfies Partial<ExecutionContext>;
  return {
    // SAFETY: the Worker and Sentry's withSentry call only waitUntil and passThroughOnException.
    ctx: ctx as ExecutionContext,
    pending,
    /** Wait for every waitUntil promise, including ones added while waiting. */
    async drain() {
      for (let i = 0; i < pending.length; i++) await pending[i];
      pending.length = 0;
    },
  };
}

/** The JOSE header and claims these tests sign; undefined leaves a field out. */
export interface JwtHeader {
  alg?: string;
  kid?: string;
}
export interface JwtClaims {
  email?: string;
  common_name?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  iat?: number;
}

export function base64Url(obj: JwtHeader | JwtClaims): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function generateKeyPair() {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
}

export async function signJwt(
  header: JwtHeader,
  payload: JwtClaims,
  privateKey: CryptoKey,
): Promise<string> {
  const headerB64 = base64Url(header);
  const payloadB64 = base64Url(payload);
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, data);
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

export async function makeValidJwt(
  overrides: { header?: JwtHeader; payload?: JwtClaims; kid?: string } = {},
) {
  const keyPair = await generateKeyPair();
  const kid = overrides.kid ?? "test-kid";
  const jwk = { ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)), kid };

  const header = { alg: "RS256", kid, ...overrides.header };
  const payload = {
    email: "user@sentry.io",
    aud: [AUD],
    iss: TEAM_DOMAIN,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    ...overrides.payload,
  };

  const jwt = await signJwt(header, payload, keyPair.privateKey);
  return { jwt, jwk, keyPair };
}

export function mockCertsEndpoint(jwk: JsonWebKey & { kid?: string }) {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })),
  );
}

const envelopeItemHeader = z.object({ type: z.string() });
const spanPayload = z.object({
  items: z.array(
    z.object({
      is_segment: z.boolean(),
      attributes: z.record(z.string(), z.object({ value: z.json() })).optional(),
    }),
  ),
});

/** Attributes of every span in the given Sentry envelopes (one envelope per string), values unwrapped. */
export function exportedSpans(envelopes: string[]): JsonObject[] {
  return envelopes.flatMap((text) => {
    const lines = text
      .split("\n")
      .filter(Boolean)
      .map((line): JsonObject => JSON.parse(line));
    const spans: JsonObject[] = [];
    // An envelope is a header line, then item-header and payload lines in pairs.
    for (let i = 1; i + 1 < lines.length; i += 2) {
      if (envelopeItemHeader.safeParse(lines[i]).data?.type !== "span") continue;
      for (const span of spanPayload.parse(lines[i + 1]).items) {
        spans.push({
          is_segment: span.is_segment,
          ...Object.fromEntries(
            Object.entries(span.attributes ?? {}).map(([key, { value }]) => [key, value]),
          ),
        });
      }
    }
    return spans;
  });
}

/**
 * Stands in for everything the Worker reaches over the network: the Access JWKS, Plausible
 * (recording the Authorization header each query carries) and a Sentry ingest host.
 */
export function stubUpstream(jwk?: JsonWebKey) {
  const plausibleAuth: string[] = [];
  const envelopes: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/cdn-cgi/access/certs" && jwk) return Response.json({ keys: [jwk] });
    if (url.hostname === "plausible.io") {
      plausibleAuth.push(request.headers.get("Authorization") ?? "");
      return Response.json({
        results: [{ dimensions: ["2026-07-30"], metrics: [1, 2, 3, 4] }],
        meta: {},
        query: {},
      });
    }
    if (url.hostname === "sentry.example") {
      envelopes.push(await request.text());
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${request.url}`);
  });
  return { plausibleAuth, envelopes };
}

export function workerClient(path: string, headers: Record<string, string>, env: Env = WORKER_ENV) {
  const transport = new StreamableHTTPClientTransport(new URL(`https://test.local${path}`), {
    requestInit: { headers },
    fetch: (url, init) => workerFetch(new Request(url, init), env),
  });
  const client = new Client({ name: "worker-e2e", version: "0.0.1" });
  return { client, connect: () => client.connect(transport) };
}

export const timeseries = {
  name: "get_timeseries",
  arguments: { site_id: "example.com", date_range: "7d" },
};

export function toolsList(path: string, headers: Record<string, string>) {
  return new Request(`https://test.local${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}
