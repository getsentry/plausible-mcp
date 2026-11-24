import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { PlausibleClient } from "../plausible.js";
import {
  siteIdSchemaFor,
  VALID_METRICS,
  queryResultOutputSchema,
  buildQueryStructuredContent,
} from "../schemas.js";
import { resolveSiteId } from "./get-timeseries.js";
import { recordMcpClientInfo } from "../mcp-telemetry.js";
import { toolErrorResult, UserFacingError } from "../errors.js";
import statsQueryReference from "../stats-query-reference.cjs";

const schemaText = JSON.stringify(statsQueryReference);
const uri = "plausible://reference/stats-query";
// Antigravity's Gemini adapter requires an items schema on every array. Publish
// a homogeneous string pair and validate positional constraints when it arrives.
const datePair = z
  .array(z.string().max(40))
  .length(2)
  .pipe(z.tuple([z.string(), z.string()]));
const orderPair = z
  .array(z.string().max(330))
  .length(2)
  .describe('A pair [metric or dimension, "asc" or "desc"].')
  .pipe(z.tuple([z.string(), z.enum(["asc", "desc"])]));
const include = z.strictObject({
  imports: z.boolean().optional(),
  total_rows: z.boolean().optional(),
  time_labels: z.boolean().optional(),
  trim_relative_date_range: z.boolean().optional(),
});
export const advancedResult = queryResultOutputSchema.extend({
  meta: z.record(z.string(), z.json()),
  query: z.record(z.string(), z.json()),
});

function advancedInput(defaultSiteId?: string) {
  return z.strictObject({
    site_id: siteIdSchemaFor(defaultSiteId),
    metrics: z.array(z.enum(VALID_METRICS)).min(1).max(VALID_METRICS.length),
    date_range: z.union([z.string().max(12), datePair]),
    dimensions: z.array(z.string().min(1).max(330)).max(8).optional(),
    filters: z
      .array(z.array(z.json()))
      .max(32)
      .optional()
      .describe('Native Stats v2 filters, e.g. [["is","visit:channel",["AI Assistants"]]].'),
    order_by: z.array(orderPair).max(22).optional(),
    include: include.optional(),
    pagination: z
      .strictObject({
        limit: z.number().int().min(1).max(1000).optional(),
        offset: z.number().int().nonnegative().optional(),
      })
      .optional(),
  });
}

export function registerAdvanced(
  server: McpServer,
  client: PlausibleClient,
  defaultSiteId?: string,
  offerFeedback = false,
) {
  server.registerResource(
    "stats-query-reference",
    uri,
    {
      title: "Plausible Stats v2 query schema",
      mimeType: "application/schema+json",
      cacheHint: { ttlMs: 3_600_000, cacheScope: "public" },
      description:
        "Upstream JSON Schema for query_stats. The tool schema gives the server's paging and input limits.",
    },
    () => ({ contents: [{ uri, mimeType: "application/schema+json", text: schemaText }] }),
  );
  server.registerTool(
    "query_stats",
    {
      title: "Run an advanced Stats query",
      description:
        "Run one read-only Plausible Stats v2 query for multiple dimensions, nested or behavioral filters, saved segment IDs, custom ordering or imports. Prefer the named tools for ordinary reports. Read plausible://reference/stats-query for the native filter grammar. Returns at most 1,000 rows (default 50).",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: advancedInput(defaultSiteId),
      outputSchema: advancedResult,
    },
    async (args, ctx) => {
      recordMcpClientInfo(ctx);
      try {
        if (JSON.stringify(args).length > 32_768)
          throw new UserFacingError("Reduce the size of the Stats query to 32,768 characters.");
        const site_id = resolveSiteId(args.site_id, defaultSiteId);
        const limit = args.pagination?.limit ?? 50;
        const offset = args.pagination?.offset ?? 0;
        const response = await client.queryBody({
          ...args,
          site_id,
          pagination: { limit: limit + 1, offset },
        });
        const pagination = { limit, offset, has_more: response.results.length > limit };
        const page = { ...response, results: response.results.slice(0, limit) };
        const structuredContent = {
          ...buildQueryStructuredContent(page, args.metrics, args.dimensions ?? [], pagination),
          meta: response.meta,
          query: response.query,
        };
        return {
          structuredContent,
          content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        };
      } catch (error) {
        return toolErrorResult(error, "query_stats", offerFeedback);
      }
    },
  );
}
