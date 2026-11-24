import * as Sentry from "@sentry/cloudflare";
import { z } from "zod";
import { sanitizeClientAttribute } from "./redaction.js";
import { CLIENT_INFO_META_KEY, type ServerContext } from "@modelcontextprotocol/server";

/** The client identity a modern request carries in its `_meta` envelope. */
const envelopeSchema = z.object({
  [CLIENT_INFO_META_KEY]: z.object({ name: z.string(), version: z.string() }),
});
const traceparentSchema = z.string().length(55);

/** The request's client identity, or undefined when its endpoint has not opted in. */
function optedInClientInfo(ctx: ServerContext | undefined) {
  if (ctx?.http?.authInfo?.extra?.recordMcpClientInfo !== true) return undefined;
  const envelope = envelopeSchema.safeParse(ctx.mcpReq?.envelope);
  return envelope.success ? envelope.data[CLIENT_INFO_META_KEY] : undefined;
}

/** Link a caller's W3C span without letting an external caller control sampling or forwarding baggage. */
function linkCallerTrace(span: Sentry.Span, ctx?: ServerContext) {
  const parent = ctx?.mcpReq?._meta?.traceparent;
  if (!parent) return;
  const value = traceparentSchema.safeParse(parent);
  if (!value.success) return;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value.data);
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return;
  if (match[1] === span.spanContext().traceId) return;
  span.addLink({
    context: {
      traceId: match[1],
      spanId: match[2],
      traceFlags: parseInt(match[3], 16) & 1,
      isRemote: true,
    },
  });
}

/** Add modern per-request client identity to the active MCP span for trace debugging. */
export function recordMcpClientInfo(ctx?: ServerContext): void {
  const span = Sentry.getActiveSpan();
  if (!span) return;
  linkCallerTrace(span, ctx);
  const clientInfo = optedInClientInfo(ctx);
  if (!clientInfo) return;

  // name/version identify the client software; title is a free-form display string
  // the client chooses and may contain a person's or workspace's name, so it's dropped.
  const name = sanitizeClientAttribute(clientInfo.name);
  const version = sanitizeClientAttribute(clientInfo.version);
  if (name !== undefined) span.setAttribute("mcp.client.name", name);
  if (version !== undefined) span.setAttribute("mcp.client.version", version);
}
