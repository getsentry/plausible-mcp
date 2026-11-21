import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as Sentry from "@sentry/cloudflare";
import { captureSentry, connect, type Harness } from "../harness.js";
import { TOOL_NAMES } from "../../src/errors.js";

const API_KEY = "plausible-key-abc123";
const baseArgs = {
  task: "Compare signups month over month",
  kind: "broken",
  impact: "worked_around",
  description: "compare_periods returned deltas with the wrong sign",
};

let h: Harness;
let sentry: ReturnType<typeof captureSentry>;
beforeAll(async () => {
  sentry = captureSentry();
  h = await connect({ apiKey: API_KEY, enableFeedbackTool: true });
});
afterAll(() => h.close());
beforeEach(() => {
  sentry.envelopes.length = 0;
});

/** The one feedback event this call sent to Sentry. */
async function sentFeedback(args: Record<string, unknown>) {
  const result = await h.call("send_feedback", args);
  await sentry.flush();
  const events = sentry.items("feedback");
  expect(events).toHaveLength(1);
  return { result, event: events[0], feedback: events[0].contexts.feedback };
}

describe("send_feedback", () => {
  it("sends the task, tool and description to Sentry as agent feedback and returns its id", async () => {
    const { result, event, feedback } = await sentFeedback({
      ...baseArgs,
      tool_name: "compare_periods",
    });

    expect(feedback).toMatchObject({
      message:
        "Task: Compare signups month over month\nTool: compare_periods\n\ncompare_periods returned deltas with the wrong sign",
      source: "mcp_agent",
    });
    expect(event.tags).toMatchObject({
      "feedback.kind": "broken",
      "feedback.impact": "worked_around",
      "feedback.tool": "compare_periods",
    });
    expect(result.structuredContent).toEqual({ feedback_id: event.event_id });
    expect(JSON.parse(result.content[0].text)).toEqual({ feedback_id: event.event_id });
  });

  it("keeps the feedback event anonymous", async () => {
    Sentry.setUser({ ip_address: "203.0.113.9" });
    try {
      const { event } = await sentFeedback(baseArgs);

      expect(event.user).toEqual({ ip_address: null });
      expect(event.request?.data).toBeUndefined();
    } finally {
      Sentry.setUser(null);
    }
  });

  it("leaves out the tool line and tag when no tool is named", async () => {
    const { event, feedback } = await sentFeedback(baseArgs);

    expect(feedback.message).toBe(
      "Task: Compare signups month over month\n\ncompare_periods returned deltas with the wrong sign",
    );
    expect(event.tags ?? {}).not.toHaveProperty("feedback.tool");
  });

  it("scrubs the caller's API key, bearer tokens and emails before they leave the process", async () => {
    await h.call("send_feedback", {
      ...baseArgs,
      task: "Report for josé@exämple.com",
      description: `Sent Authorization: Bearer abc.def-123 with key ${API_KEY} for ops@example.com`,
    });
    await sentry.flush();

    const wire = JSON.stringify(sentry.envelopes);
    for (const secret of [API_KEY, "abc.def-123", "ops@example.com", "josé"]) {
      expect(wire).not.toContain(secret);
    }
    expect(wire).toContain("[REDACTED_API_KEY]");
  });

  it("caps the message at Sentry's feedback length", async () => {
    const { feedback } = await sentFeedback({ ...baseArgs, description: "x".repeat(4096) });

    expect(feedback.message).toHaveLength(4096);
  });

  it("offers exactly this server's query tools as tool_name, as a non-destructive write", async () => {
    const { tools } = await h.client.listTools();
    const tool = tools.find((t) => t.name === "send_feedback")!;
    const queryTools = tools.filter((t) => t.name !== "send_feedback").map((t) => t.name);

    expect((tool.inputSchema.properties as any).tool_name.enum.sort()).toEqual(queryTools.sort());
    expect([...TOOL_NAMES].sort()).toEqual(queryTools.sort());
    expect(tool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });
});
