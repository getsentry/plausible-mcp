import { createMcpHandler } from "agents/mcp";
import { createServer } from "./server.js";

interface Env {
  PLAUSIBLE_API_KEY: string;
  PLAUSIBLE_BASE_URL?: string;
  PLAUSIBLE_DEFAULT_SITE_ID?: string;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    // Create a fresh server per request (required for MCP SDK 1.26.0+)
    const server = createServer({
      apiKey: env.PLAUSIBLE_API_KEY,
      baseUrl: env.PLAUSIBLE_BASE_URL,
      defaultSiteId: env.PLAUSIBLE_DEFAULT_SITE_ID,
    });

    return createMcpHandler(server)(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
