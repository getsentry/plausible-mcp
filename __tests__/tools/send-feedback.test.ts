import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";

const sentry = vi.hoisted(() => ({
  captureFeedback: vi.fn(() => "feedback-event-id"),
  addEventProcessor: vi.fn(),
}));

vi.mock("@sentry/cloudflare", () => ({
  captureFeedback: sentry.captureFeedback,
  withScope: (cb: (scope: { addEventProcessor: typeof sentry.addEventProcessor }) => unknown) =>
    cb({ addEventProcessor: sentry.addEventProcessor }),
}));

import { register } from "../../src/tools/send-feedback.js";

const API_KEY = "plausible-key-abc123";

function getTool(server: McpServer) {
  return ((server as any)._registeredTools as Record<string, any>)["send_feedback"];
}

function callTool(server: McpServer, args: Record<string, unknown>) {
  return getTool(server).handler(args, {} as any);
}

const baseArgs = {
  task: "Compare signups month over month",
  kind: "broken",
  impact: "worked_around",
  description: "compare_periods returned deltas with the wrong sign",
};

describe("send_feedback tool", () => {
  let server: McpServer;

  beforeEach(() => {
    sentry.captureFeedback.mockClear();
    sentry.addEventProcessor.mockClear();
    server = new McpServer({ name: "test", version: "0.0.1" });
    register(server, API_KEY);
  });

  it("sends the task, tool and description as agent feedback", async () => {
    const result = await callTool(server, { ...baseArgs, tool_name: "compare_periods" });

    expect(sentry.captureFeedback).toHaveBeenCalledWith({
      message:
        "Task: Compare signups month over month\nTool: compare_periods\n\ncompare_periods returned deltas with the wrong sign",
      source: "mcp_agent",
      tags: {
        "feedback.kind": "broken",
        "feedback.impact": "worked_around",
        "feedback.tool": "compare_periods",
      },
    });
    expect(sentry.addEventProcessor).toHaveBeenCalledWith(expect.any(Function));
    expect(result.structuredContent).toEqual({ feedback_id: "feedback-event-id" });
    expect(JSON.parse(result.content[0].text)).toEqual({ feedback_id: "feedback-event-id" });
    expect(result.isError).toBeUndefined();
  });

  it("leaves out the tool line and tag when no tool is named", async () => {
    await callTool(server, baseArgs);

    const params = sentry.captureFeedback.mock.calls[0][0] as any;
    expect(params.message).toBe(
      "Task: Compare signups month over month\n\ncompare_periods returned deltas with the wrong sign"
    );
    expect(params.tags).not.toHaveProperty("feedback.tool");
  });

  it("scrubs the caller's API key, bearer tokens and emails", async () => {
    await callTool(server, {
      ...baseArgs,
      task: "Report for josé@exämple.com",
      description: `Sent Authorization: Bearer abc.def-123 with key ${API_KEY} for ops@example.com`,
    });

    const { message } = sentry.captureFeedback.mock.calls[0][0] as any;
    expect(message).not.toContain(API_KEY);
    expect(message).not.toContain("abc.def-123");
    expect(message).not.toContain("ops@example.com");
    expect(message).not.toContain("josé");
    expect(message).toContain("Task: Report for [REDACTED_EMAIL]");
    expect(message).toContain("[REDACTED_API_KEY]");
  });

  it("caps the message at Sentry's feedback length", async () => {
    await callTool(server, { ...baseArgs, description: "x".repeat(4096) });

    const { message } = sentry.captureFeedback.mock.calls[0][0] as any;
    expect(message).toHaveLength(4096);
  });

  it("only accepts this server's query tools as tool_name", () => {
    const schema = getTool(server).inputSchema;
    expect(schema.safeParse({ ...baseArgs, tool_name: "get_breakdown" }).success).toBe(true);
    expect(schema.safeParse({ ...baseArgs, tool_name: "search_issues" }).success).toBe(false);
  });

  it("declares a non-destructive write", () => {
    expect(getTool(server).annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });
});
