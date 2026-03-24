import { createMcpHandler } from "agents/mcp";
import { createServer } from "./server.js";

interface Env {
  PLAUSIBLE_BASE_URL?: string;
  PLAUSIBLE_DEFAULT_SITE_ID?: string;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    // Extract the user's Plausible API key from the Authorization header.
    // Each user provides their own key — no shared secret.
    const authHeader = request.headers.get("Authorization");
    const apiKey = authHeader?.replace(/^Bearer\s+/i, "");

    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error: "Missing Plausible API key. Pass it as a Bearer token in the Authorization header.",
        }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // Create a fresh server per request with the user's own API key
    const server = createServer({
      apiKey,
      baseUrl: env.PLAUSIBLE_BASE_URL,
      defaultSiteId: env.PLAUSIBLE_DEFAULT_SITE_ID,
    });

    return createMcpHandler(server)(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
