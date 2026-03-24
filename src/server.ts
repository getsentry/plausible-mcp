import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PlausibleClient } from "./plausible.js";
import { register as registerTimeseries } from "./tools/get-timeseries.js";
import { register as registerBreakdown } from "./tools/get-breakdown.js";
import { register as registerConversions } from "./tools/get-conversions.js";
import { register as registerComparePeriods } from "./tools/compare-periods.js";

export interface ServerConfig {
  apiKey: string;
  baseUrl?: string;
  defaultSiteId?: string;
}

export function createServer(config: ServerConfig): McpServer {
  const server = new McpServer({
    name: "plausible-mcp",
    version: "0.1.0",
  });

  const client = new PlausibleClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });

  registerTimeseries(server, client, config.defaultSiteId);
  registerBreakdown(server, client, config.defaultSiteId);
  registerConversions(server, client, config.defaultSiteId);
  registerComparePeriods(server, client, config.defaultSiteId);

  return server;
}
