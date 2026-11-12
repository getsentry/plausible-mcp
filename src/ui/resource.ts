import type { McpServer } from "@modelcontextprotocol/server";
import { analyticsHtml } from "./view.js";

const uri = "ui://plausible/analytics-v1.html";
const appMimeType = "text/html;profile=mcp-app";
export const appToolMeta = { ui: { resourceUri: uri }, "ui/resourceUri": uri };

export function registerAnalyticsView(server: McpServer) {
  const metadata = { mimeType: appMimeType, _meta: { ui: { prefersBorder: true } } };
  server.registerResource(
    "analytics",
    uri,
    {
      title: "Plausible Analytics",
      ...metadata,
      cacheHint: { ttlMs: 3_600_000, cacheScope: "public" },
    },
    () => ({ contents: [{ uri, ...metadata, text: analyticsHtml }] }),
  );
}
