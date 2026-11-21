import * as Sentry from "@sentry/cloudflare";
import { z } from "zod";
import { sanitizeClientAttribute } from "./redaction.js";
import { CLIENT_INFO_META_KEY, type ServerContext } from "@modelcontextprotocol/server";

/** The client identity a modern request carries in its `_meta` envelope. */
const envelopeSchema = z.object({
  [CLIENT_INFO_META_KEY]: z.object({ name: z.string(), version: z.string() }),
});

/** The request's client identity, or undefined when its endpoint has not opted in. */
function optedInClientInfo(ctx: ServerContext | undefined) {
  if (ctx?.http?.authInfo?.extra?.recordMcpClientInfo !== true) return undefined;
  const envelope = envelopeSchema.safeParse(ctx.mcpReq?.envelope);
  return envelope.success ? envelope.data[CLIENT_INFO_META_KEY] : undefined;
}

/** Add modern per-request client identity to the active MCP span for trace debugging. */
export function recordMcpClientInfo(ctx?: ServerContext): void {
  const clientInfo = optedInClientInfo(ctx);
  if (!clientInfo) return;
  const span = Sentry.getActiveSpan();
  if (!span) return;

  // name/version identify the client software; title is a free-form display string
  // the client chooses and may contain a person's or workspace's name, so it's dropped.
  const name = sanitizeClientAttribute(clientInfo.name);
  const version = sanitizeClientAttribute(clientInfo.version);
  if (name !== undefined) span.setAttribute("mcp.client.name", name);
  if (version !== undefined) span.setAttribute("mcp.client.version", version);
}
