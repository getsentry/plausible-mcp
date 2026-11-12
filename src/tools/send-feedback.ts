import { z } from "zod";
import * as Sentry from "@sentry/cloudflare";
import type { McpServer } from "@modelcontextprotocol/server";
import { appToolMeta } from "../ui/resource.js";
import { TOOL_NAMES } from "../errors.js";
import { recordMcpClientInfo } from "../mcp-telemetry.js";
import {
  anonymizeEventWithoutEmail,
  scrubFeedbackText,
  type RedactableEvent,
} from "../redaction.js";

// Sentry truncates User Feedback messages beyond this length.
const FEEDBACK_MAX_LENGTH = 4096;

/**
 * Lets the calling agent file feedback about this MCP server into Sentry User Feedback,
 * linked to the active trace. Registered only when the hosting entry point runs with Sentry
 * (`ServerConfig.enableFeedbackTool`) — without an initialized SDK the feedback would go
 * nowhere, so the tool is hidden rather than silently dropping submissions.
 *
 * Keep the kind/impact values and the `mcp_agent` source in step with getsentry/sentry-mcp's
 * `submit_feedback_to_sentry_team`, so reports from both servers triage the same way.
 *
 * The text is untrusted caller input: it is bounded by the schema, scrubbed, and passed to
 * Sentry as data, never interpreted. `Sentry.captureFeedback` produces `type: "feedback"`
 * events, which never reach `beforeSend` — so the privacy guardrail is attached directly to
 * this call's scope instead.
 */
export function register(server: McpServer, apiKey: string) {
  server.registerTool(
    "send_feedback",
    {
      title: "Send Feedback",
      description:
        "Send feedback about this server to its maintainers, not to Plausible. Use it at most once per task, after you finish or give up, when a tool was missing, broken, or confusing.",
      _meta: { ...appToolMeta, ui: { ...appToolMeta.ui, visibility: ["model"] } },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      outputSchema: z.object({ feedback_id: z.string() }),
      inputSchema: z.strictObject({
        task: z.string().min(1).max(200).describe("What the user asked you to do"),
        kind: z
          .enum(["missing", "broken", "confusing", "idea"])
          .describe(
            "missing: no tool or argument for it; broken: an error or wrong data; confusing: an unclear description, error, or result; idea: an improvement"
          ),
        impact: z.enum(["blocked", "worked_around", "friction"]),
        description: z
          .string()
          .min(10)
          .max(FEEDBACK_MAX_LENGTH)
          .describe("The call you made, what happened, and what you expected"),
        tool_name: z.enum(TOOL_NAMES).optional(),
      }),
    },
    async (args, ctx) => {
      recordMcpClientInfo(ctx);
      const header = args.tool_name
        ? `Task: ${args.task}\nTool: ${args.tool_name}`
        : `Task: ${args.task}`;
      const message = scrubFeedbackText(`${header}\n\n${args.description}`, apiKey).slice(
        0,
        FEEDBACK_MAX_LENGTH
      );
      const feedbackId = Sentry.withScope((scope) => {
        scope.addEventProcessor((event) => {
          anonymizeEventWithoutEmail(event as RedactableEvent);
          return event;
        });
        return Sentry.captureFeedback({
          message,
          source: "mcp_agent",
          tags: {
            "feedback.kind": args.kind,
            "feedback.impact": args.impact,
            ...(args.tool_name && { "feedback.tool": args.tool_name }),
          },
        });
      });

      const result = { feedback_id: feedbackId };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    }
  );
}
