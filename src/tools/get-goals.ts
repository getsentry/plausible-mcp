import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { PlausibleApiError, type PlausibleClient } from "../plausible.js";
import { recordMcpClientInfo } from "../mcp-telemetry.js";
import { siteIdSchemaFor } from "../schemas.js";
import { resolveSiteId } from "./get-timeseries.js";

// Preserve additional upstream definition fields without inventing missing values.
const goalSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).optional(),
  goal_type: z.string().min(1),
  display_name: z.string().min(1),
  event_name: z.string().nullable().optional(),
  page_path: z.string().nullable().optional(),
  custom_props: z.record(z.string(), z.unknown()).nullable().optional(),
});
const pageSchema = z.object({
  goals: z.array(goalSchema),
  meta: z.object({ after: z.string().min(1).nullable() }),
});
const outputSchema = z.object({
  status: z.enum(["available", "unsupported", "permission_denied", "unavailable"]),
  site_id: z.string().optional(),
  goals: z.array(goalSchema),
  next_after: z.string().nullable(),
  completeness: z.enum(["complete", "partial", "unknown"]),
  message: z.string(),
});

export function register(server: McpServer, client: PlausibleClient, defaultSiteId?: string) {
  server.registerTool("get_goals", {
    title: "Get Configured Goals",
    description: "Discover configured goals independently of conversion activity, including goals with zero conversions. Returns display_name (use as goal in statistics queries), event_name, page_path and other definitions when provided. Follow next_after before concluding a goal is missing. Unsupported/denied discovery means configuration is unknown; no broader credentials or activity-based inference are used.",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      site_id: siteIdSchemaFor(defaultSiteId),
      after: z.string().min(1).optional().describe("next_after from the previous page; keep the same site"),
    }),
    outputSchema,
  }, async (args, ctx) => {
    recordMcpClientInfo(ctx);
    let result: z.infer<typeof outputSchema>;
    try {
      const siteId = resolveSiteId(args.site_id, defaultSiteId);
      const page = pageSchema.parse(await client.getGoals(siteId, args.after));
      const complete = !args.after && page.meta.after === null;
      result = {
        status: "available", site_id: siteId, goals: page.goals,
        next_after: page.meta.after, completeness: complete ? "complete" : "partial",
        message: "Configured goals, not conversion counts. Use display_name to query activity with get_conversions. Follow all pages before declaring a goal unconfigured; an empty conversion result does not prove a goal is missing.",
      };
    } catch (error) {
      const code = error instanceof PlausibleApiError ? error.status : undefined;
      const status = code === 401 || code === 403 ? "permission_denied"
        : code === 404 || code === 405 || code === 501 ? "unsupported" : "unavailable";
      result = {
        status, goals: [], next_after: null, completeness: "unknown",
        message: `Goal configuration ${status}${code ? ` (HTTP ${code})` : ""}. Configuration is unknown, not an empty configured-goal list. The endpoint, site or permission may be unavailable. No activity-based fallback or broader credentials are used.`,
      };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });
}
