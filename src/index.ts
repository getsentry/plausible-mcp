#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const apiKey = process.env.PLAUSIBLE_API_KEY;
if (!apiKey) {
  console.error(
    "Error: PLAUSIBLE_API_KEY environment variable is required.\n" +
      "Get your API key from Plausible Settings > API Keys."
  );
  process.exit(1);
}

const server = createServer({
  apiKey,
  baseUrl: process.env.PLAUSIBLE_BASE_URL,
  defaultSiteId: process.env.PLAUSIBLE_DEFAULT_SITE_ID,
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("plausible-mcp server running on stdio");
