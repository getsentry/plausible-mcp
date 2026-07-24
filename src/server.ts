import * as Sentry from "@sentry/cloudflare";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PlausibleClient } from "./plausible.js";
import { register as registerTimeseries } from "./tools/get-timeseries.js";
import { register as registerBreakdown } from "./tools/get-breakdown.js";
import { register as registerConversions } from "./tools/get-conversions.js";
import { register as registerComparePeriods } from "./tools/compare-periods.js";
import { register as registerSendFeedback } from "./tools/send-feedback.js";

export interface ServerConfig {
  apiKey: string;
  baseUrl?: string;
  defaultSiteId?: string;
  /**
   * Record MCP tool inputs (arguments) and outputs (results) into Sentry spans. Enabled only
   * on the SSO-gated `/internal` endpoint, which queries a shared server-side key; left off for
   * bring-your-own-key `/mcp` traffic, whose inputs/outputs are the caller's own data.
   */
  recordToolIO?: boolean;
  /**
   * Register the `send_feedback` tool, which files agent/user feedback into Sentry User
   * Feedback. Only meaningful where the Sentry SDK is initialized (the Worker); the STDIO
   * entry point leaves it off so the tool is never offered somewhere submissions would be
   * dropped.
   */
  enableFeedbackTool?: boolean;
}

/**
 * Usage guidance surfaced to MCP clients in the `initialize` response and injected into the
 * model's context. It documents the Stats API v2 constraints that clients most often get wrong
 * (date formats, future dates, illegal metric/dimension combinations) to cut the resulting
 * 400s at the source.
 */
const SERVER_INSTRUCTIONS = `This server queries Plausible Analytics (Stats API v2) for a site's traffic and conversions. All tools are read-only.

DATE RANGES (date_range, period_a, period_b):
- Relative: "7d", "30d", "12mo" (N days/months back), or "day", "month", "year", "all".
- Absolute: "YYYY-MM-DD,YYYY-MM-DD" (start,end), both inclusive.
- Dates must not be in the future. Today is the latest valid date; a range that ends after today returns a 400.

METRICS: visitors, visits, pageviews, views_per_visit, bounce_rate, visit_duration, events, scroll_depth, percentage, conversion_rate, group_conversion_rate, average_revenue, total_revenue, time_on_page.

DIMENSIONS (get_breakdown): event:page, event:goal, event:hostname, visit:entry_page, visit:exit_page, visit:source, visit:referrer, visit:channel, visit:utm_medium/source/campaign/content/term, visit:device, visit:browser(_version), visit:os(_version). Geography comes in two forms: visit:country/region/city return ISO/Geoname codes, while visit:country_name/region_name/city_name return human-readable names — prefer the *_name variants when presenting geography to users.

COMBINATION RULES:
- Session metrics (bounce_rate, visit_duration, views_per_visit, visits) cannot be combined with event-level dimensions (event:goal, event:page, event:hostname) or goal filters. Use event-level metrics (visitors, pageviews, events, conversion_rate) in those cases.
- For goal conversions, use get_conversions rather than passing session metrics alongside a goal.

SITE: site_id is a bare domain (e.g. "example.com"). If omitted, the server's default site is used; if there is no default, the call fails — ask the user which site to query.`;

const FEEDBACK_INSTRUCTIONS = `

FEEDBACK: If a tool result confuses you, an error message doesn't help you fix the call, or you cannot express the query you need, report it with send_feedback — it goes straight to the server's maintainers.`;

export function createServer(config: ServerConfig): McpServer {
  const server = Sentry.wrapMcpServerWithSentry(
    new McpServer(
      {
        name: "plausible-mcp",
        version: "0.6.0",
      },
      {
        instructions: config.enableFeedbackTool
          ? SERVER_INSTRUCTIONS + FEEDBACK_INSTRUCTIONS
          : SERVER_INSTRUCTIONS,
      },
    ),
    {
      recordInputs: config.recordToolIO ?? false,
      recordOutputs: config.recordToolIO ?? false,
    },
  );

  const client = new PlausibleClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });

  registerTimeseries(server, client, config.defaultSiteId);
  registerBreakdown(server, client, config.defaultSiteId);
  registerConversions(server, client, config.defaultSiteId);
  registerComparePeriods(server, client, config.defaultSiteId);
  if (config.enableFeedbackTool) {
    registerSendFeedback(server);
  }

  return server;
}
