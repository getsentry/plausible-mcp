#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.js";

const apiKey = process.env.PLAUSIBLE_API_KEY;
if (!apiKey) {
  console.error(
    "Error: PLAUSIBLE_API_KEY environment variable is required.\n" +
      "Get your API key from Plausible Settings > API Keys.",
  );
  process.exit(1);
}

serveStdio(
  () =>
    createServer({
      apiKey,
      baseUrl: process.env.PLAUSIBLE_BASE_URL,
      defaultSiteId: process.env.PLAUSIBLE_DEFAULT_SITE_ID,
    }),
  {
    onerror: (error) => console.error("plausible-mcp stdio error:", error),
  },
);
console.error("plausible-mcp server running on stdio");
