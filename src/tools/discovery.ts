import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { PlausibleClient } from "../plausible.js";
import { siteIdSchemaFor } from "../schemas.js";
import { resolveSiteId } from "./get-timeseries.js";
import { toolErrorResult, UserFacingError } from "../errors.js";
import { recordMcpClientInfo } from "../mcp-telemetry.js";

const annotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };
const cursor = z
  .string()
  .min(1)
  .max(1024)
  .optional()
  .describe("Next-page cursor from the preceding response.");
const meta = z.object({ after: z.string().nullable() });
export const sitesSchema = z.object({
  sites: z.array(z.object({ domain: z.string(), timezone: z.string() })),
  meta,
});
const goalsSchema = z.object({
  goals: z.array(z.object({ display_name: z.string(), goal_type: z.string() })),
  meta,
});
const propsSchema = z.object({ custom_properties: z.array(z.object({ property: z.string() })) });
export const metadataSchema = z.object({
  goals: goalsSchema.shape.goals.optional(),
  meta: meta.optional(),
  custom_properties: propsSchema.shape.custom_properties.optional(),
});

function pageParams(after?: string) {
  const params = new URLSearchParams({ limit: "100" });
  if (after) params.set("after", after);
  return params;
}

export function registerSites(server: McpServer, client: PlausibleClient, offerFeedback: boolean) {
  server.registerTool(
    "list_sites",
    {
      title: "List sites",
      description:
        "Find site domains and time zones that the caller's Plausible key can access. Use when the site is unknown.",
      annotations,
      inputSchema: z.strictObject({ after: cursor }),
      outputSchema: sitesSchema,
    },
    async ({ after }, ctx) => {
      recordMcpClientInfo(ctx);
      try {
        const result = sitesSchema.parse(await client.metadata("sites", pageParams(after)));
        return {
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        return toolErrorResult(error, "list_sites", offerFeedback);
      }
    },
  );
}

export function registerMetadata(
  server: McpServer,
  client: PlausibleClient,
  defaultSiteId?: string,
  offerFeedback = false,
) {
  server.registerTool(
    "get_site_metadata",
    {
      title: "Discover goals or properties",
      description:
        "List configured goal names (including goals with zero conversions) or custom property keys for a site. Use a goal's display_name in a query.",
      annotations,
      inputSchema: z.strictObject({
        site_id: siteIdSchemaFor(defaultSiteId),
        kind: z.enum(["goals", "custom_properties"]),
        after: cursor,
      }),
      outputSchema: metadataSchema,
    },
    async (args, ctx) => {
      recordMcpClientInfo(ctx);
      try {
        const site = resolveSiteId(args.site_id, defaultSiteId);
        if (args.kind === "custom_properties" && args.after)
          throw new UserFacingError("Custom properties have no pagination cursor.");
        const params = args.kind === "goals" ? pageParams(args.after) : new URLSearchParams();
        params.set("site_id", site);
        const result =
          args.kind === "goals"
            ? goalsSchema.parse(await client.metadata("goals", params))
            : propsSchema.parse(await client.metadata("custom-props", params));
        return {
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        return toolErrorResult(error, "get_site_metadata", offerFeedback);
      }
    },
  );
}
