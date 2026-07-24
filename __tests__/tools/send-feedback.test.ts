import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const sentry = vi.hoisted(() => ({
  captureFeedback: vi.fn(() => "feedback-event-id"),
  withScope: vi.fn(),
  setTag: vi.fn(),
}));

vi.mock("@sentry/cloudflare", () => ({
  captureFeedback: sentry.captureFeedback,
  withScope: (cb: (scope: { setTag: typeof sentry.setTag }) => unknown) =>
    cb({ setTag: sentry.setTag }),
}));

import { register } from "../../src/tools/send-feedback.js";

function getToolHandler(server: McpServer, toolName: string) {
  const tools = (server as any)._registeredTools as Record<string, any>;
  const tool = tools?.[toolName];
  if (!tool) throw new Error(`Tool ${toolName} not registered`);
  return async (args: Record<string, unknown>) => tool.handler(args, {} as any);
}

describe("send_feedback tool", () => {
  let server: McpServer;

  beforeEach(() => {
    sentry.captureFeedback.mockClear();
    sentry.setTag.mockClear();
    server = new McpServer({ name: "test", version: "0.0.1" });
    register(server);
  });

  it("captures the message as Sentry feedback and returns the feedback id", async () => {
    const handler = getToolHandler(server, "send_feedback");
    const result = await handler({
      message: "get_breakdown rejected my dimension and the error did not say which values are valid",
      category: "confusing_error",
      tool_name: "get_breakdown",
    });

    expect(sentry.captureFeedback).toHaveBeenCalledWith({
      message:
        "get_breakdown rejected my dimension and the error did not say which values are valid",
    });
    expect(sentry.setTag).toHaveBeenCalledWith("feedback.category", "confusing_error");
    expect(sentry.setTag).toHaveBeenCalledWith("feedback.tool", "get_breakdown");
    expect(result.structuredContent).toEqual({
      recorded: true,
      feedback_id: "feedback-event-id",
    });
    expect(result.isError).toBeUndefined();
  });

  it("defaults the category tag when none is given", async () => {
    const handler = getToolHandler(server, "send_feedback");
    await handler({ message: "something long enough to pass validation" });

    expect(sentry.setTag).toHaveBeenCalledWith("feedback.category", "bug");
    expect(sentry.setTag).not.toHaveBeenCalledWith("feedback.tool", expect.anything());
  });

  it("is not registered as read-only", () => {
    const tool = ((server as any)._registeredTools as Record<string, any>)["send_feedback"];
    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(tool.annotations.idempotentHint).toBe(false);
  });
});
