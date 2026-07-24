import { z } from "zod";
import * as Sentry from "@sentry/cloudflare";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const FEEDBACK_CATEGORIES = [
  "bug",
  "confusing_error",
  "unexpected_results",
  "feature_request",
  "praise",
] as const;

/**
 * Lets the calling agent (or its user) file feedback about this MCP server into
 * Sentry User Feedback, linked to the active trace. Registered only when the
 * hosting entry point runs with Sentry (`ServerConfig.enableFeedbackTool`) —
 * without an initialized SDK the feedback would go nowhere, so the tool is
 * hidden rather than silently dropping submissions.
 *
 * The message is untrusted caller input: it is bounded by the schema and passed
 * to Sentry as data, never interpreted. On `/internal` the feedback inherits the
 * authenticated user from the isolation scope; BYOK `/mcp` feedback stays
 * anonymous, matching the endpoint's privacy posture.
 */
export function register(server: McpServer) {
  server.registerTool(
    "send_feedback",
    {
      title: "Send Feedback",
      description:
        "Report feedback about this MCP server to its maintainers: a confusing error, a query you could not express, results that did not match expectations, or something that worked well. Use this after hitting friction with the other tools so the server can improve.",
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
      outputSchema: {
        recorded: z.boolean(),
        feedback_id: z.string().optional(),
      },
      inputSchema: {
        message: z
          .string()
          .min(10)
          .max(4000)
          .describe(
            "What happened and what you expected. Name the tool and the arguments that caused friction; never include API keys or secrets."
          ),
        category: z
          .enum(FEEDBACK_CATEGORIES)
          .default("bug")
          .describe("The kind of feedback"),
        tool_name: z
          .string()
          .max(64)
          .optional()
          .describe("Which tool the feedback is about, if any (e.g. get_breakdown)"),
      },
    },
    async (args) => {
      const feedbackId = Sentry.withScope((scope) => {
        scope.setTag("feedback.category", args.category ?? "bug");
        if (args.tool_name) {
          scope.setTag("feedback.tool", args.tool_name);
        }
        return Sentry.captureFeedback({ message: args.message });
      });

      return {
        content: [
          {
            type: "text" as const,
            text: "Feedback recorded — thank you. The maintainers review submissions in Sentry User Feedback.",
          },
        ],
        structuredContent: { recorded: true, feedback_id: feedbackId },
      };
    }
  );
}
