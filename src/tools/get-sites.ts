import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { PlausibleApiError, type PlausibleClient } from "../plausible.js";
import { recordMcpClientInfo } from "../mcp-telemetry.js";

const status = z.enum(["available", "unsupported", "permission_denied", "unavailable"]);
const siteSchema = z.object({
  site_id: z.string(),
  timezone: z.string().nullable(),
  timezone_status: z.enum(["available", "unavailable"]),
  today: z.string().nullable(),
  is_default: z.boolean(),
});
const outputSchema = z.object({
  status,
  sites: z.array(siteSchema),
  next_after: z.string().nullable(),
  message: z.string().optional(),
});
const rawSite = z.object({ domain: z.string().min(1), timezone: z.unknown().optional() });

export function register(server: McpServer, client: PlausibleClient, defaultSiteId?: string) {
  server.registerTool("get_sites", {
    title: "Get Sites",
    description: "Discover authorized Plausible site IDs and reporting time zones. Use site_id for one site, use_default for the verified server default, or omit both to list sites. Follow next_after for pagination. Returns explicit unsupported, permission_denied or unavailable status when metadata cannot be obtained.",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      site_id: z.string().min(1).optional(),
      use_default: z.boolean().optional(),
      after: z.string().min(1).optional().describe("next_after cursor from a preceding list result"),
    }),
    outputSchema,
  }, async (args, ctx) => {
    recordMcpClientInfo(ctx);
    let result: z.infer<typeof outputSchema>;
    try {
      if ((args.site_id && args.use_default) || (args.after && (args.site_id || args.use_default))) {
        throw new Error("Use either site_id, use_default, or list pagination.");
      }
      const target = args.use_default ? defaultSiteId : args.site_id;
      if (args.use_default && !target) throw new Error("No server default site is configured.");
      const raw = await client.getSitesMetadata(target, args.after);
      const page = target
        ? { sites: [rawSite.parse(raw)], meta: { after: null } }
        : z.object({ sites: z.array(rawSite), meta: z.object({ after: z.string().nullable() }) }).parse(raw);
      const now = new Date();
      const sites = page.sites.map((site) => {
        let timezone: string | null = null;
        let today: string | null = null;
        if (typeof site.timezone === "string" && site.timezone.length) {
          try {
            const parts = new Intl.DateTimeFormat("en-US", {
              timeZone: site.timezone, year: "numeric", month: "2-digit", day: "2-digit",
            }).formatToParts(now);
            const part = (type: string) => parts.find((p) => p.type === type)!.value;
            today = `${part("year")}-${part("month")}-${part("day")}`;
            timezone = site.timezone;
          } catch { /* Missing/invalid zones must never fall back to the runtime zone. */ }
        }
        return { site_id: site.domain, timezone, today,
          timezone_status: timezone ? "available" as const : "unavailable" as const,
          is_default: site.domain === defaultSiteId };
      });
      result = { status: "available", sites, next_after: page.meta.after };
    } catch (error) {
      const code = error instanceof PlausibleApiError ? error.status : undefined;
      const failure = code === 401 || code === 403 ? "permission_denied"
        : code === 404 || code === 405 || code === 501 ? "unsupported" : "unavailable";
      result = { status: failure, sites: [], next_after: null,
        message: code ? `Site metadata ${failure} (HTTP ${code}). The current key or Plausible version may not support the read-only Sites API.`
          : "Site metadata unavailable. Check the request, server default, network connection and Sites API response." };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], structuredContent: result };
  });
}
