import * as Sentry from "@sentry/cloudflare";
import {
  CLIENT_INFO_META_KEY,
  type Implementation,
  type ServerContext,
} from "@modelcontextprotocol/server";

/** Add modern per-request client identity to the active MCP span for trace debugging. */
export function recordMcpClientInfo(ctx?: ServerContext): void {
  if (ctx?.http?.authInfo?.extra?.recordMcpClientInfo !== true) return;
  const envelope = ctx?.mcpReq?.envelope as Record<string, unknown> | undefined;
  const clientInfo = envelope?.[CLIENT_INFO_META_KEY] as Implementation | undefined;
  if (!clientInfo) return;
  const span = Sentry.getActiveSpan();
  if (!span) return;

  // name/version identify the client software; title is a free-form display string
  // the client chooses and may contain a person's or workspace's name, so it's dropped.
  span.setAttribute("mcp.client.name", clientInfo.name);
  span.setAttribute("mcp.client.version", clientInfo.version);
}
