import * as Sentry from "@sentry/cloudflare";
import { createMcpHandler } from "agents/mcp";
import { createServer } from "./server.js";

interface Env {
  PLAUSIBLE_BASE_URL?: string;
  PLAUSIBLE_DEFAULT_SITE_ID?: string;
  SENTRY_RELEASE?: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Accept, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function corsResponse(response: Response): Response {
  const patched = new Response(response.body, response);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    patched.headers.set(key, value);
  }
  return patched;
}

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: "https://de333c4dff86900878d446e663271b2a@o4509446862274560.ingest.us.sentry.io/4511179029020672",
    release: env.SENTRY_RELEASE,
    tracesSampleRate: 1.0,
    sendDefaultPii: true,
  }),
  {
    async fetch(
      request: Request,
      env: Env,
      ctx: ExecutionContext,
    ): Promise<Response> {
      // Handle CORS preflight
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      // Extract the user's Plausible API key from the Authorization header.
      // Each user provides their own key — no shared secret.
      const authHeader = request.headers.get("Authorization");
      const apiKey = authHeader?.replace(/^Bearer\s+/i, "");

      if (!apiKey) {
        return corsResponse(
          new Response(
            JSON.stringify({
              error:
                "Missing Plausible API key. Pass it as a Bearer token in the Authorization header.",
            }),
            { status: 401, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      // Create a fresh server per request with the user's own API key
      const server = createServer({
        apiKey,
        baseUrl: env.PLAUSIBLE_BASE_URL,
        defaultSiteId: env.PLAUSIBLE_DEFAULT_SITE_ID,
      });

      const response = await createMcpHandler(server)(request, env, ctx);
      return corsResponse(response);
    },
  } satisfies ExportedHandler<Env>,
);
