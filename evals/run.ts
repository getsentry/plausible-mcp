#!/usr/bin/env tsx

import OpenAI from "openai";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../src/server.js";
import { cases } from "./cases.js";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("OPENROUTER_API_KEY is required to run evals.");
  console.error("Usage: OPENROUTER_API_KEY=sk-or-... pnpm eval");
  process.exit(1);
}

// OpenRouter speaks the OpenAI chat-completions API; model ids are "<vendor>/<model>".
const model = process.env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-5";

const openrouter = new OpenAI({
  apiKey,
  baseURL: "https://openrouter.ai/api/v1",
});

async function getEvalContext() {
  const server = createServer({
    apiKey: "eval-key",
    defaultSiteId: "example.com",
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "eval-client", version: "0.0.1" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const instructions = client.getInstructions();
    if (!instructions) throw new Error("Missing server instructions during MCP initialization");
    const { tools } = await client.listTools();
    return {
      instructions,
      tools: tools.map(tool => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description ?? "",
          parameters: tool.inputSchema as Record<string, unknown>,
        },
      })),
    };
  } finally {
    await client.close();
    await server.close();
  }
}

async function runEval(
  context: Awaited<ReturnType<typeof getEvalContext>>,
  evalCase: (typeof cases)[0]
): Promise<{ pass: boolean; errors: string[] }> {
  const response = await openrouter.chat.completions.create({
    model,
    max_tokens: 1024,
    messages: [
      {
        role: "system",
        content:
          "You are a marketing analytics assistant. Use example.com unless the user names another site.\n\n" + context.instructions,
      },
      { role: "user", content: evalCase.prompt },
    ],
    tools: context.tools,
  });

  const toolCall = response.choices[0]?.message.tool_calls?.[0];

  if (!toolCall || toolCall.type !== "function") {
    return { pass: false, errors: ["No tool call in response"] };
  }

  const errors: string[] = [];

  if (toolCall.function.name !== evalCase.expectedTool) {
    errors.push(
      `Wrong tool: expected "${evalCase.expectedTool}", got "${toolCall.function.name}"`
    );
  }

  // Arguments arrive as a JSON string, unlike Anthropic's already-parsed input.
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(toolCall.function.arguments || "{}");
  } catch {
    return {
      pass: false,
      errors: [
        ...errors,
        `Tool arguments were not valid JSON: ${toolCall.function.arguments}`,
      ],
    };
  }

  errors.push(...evalCase.assertions(args));

  return { pass: errors.length === 0, errors };
}

// Main
async function main() {
  console.log("Loading tool schemas from MCP server...\n");
  const context = await getEvalContext();
  const { tools } = context;
  console.log(
    `Found ${tools.length} tools: ${tools.map((t) => t.function.name).join(", ")}`
  );
  console.log(`Model: ${model}\n`);

  let passed = 0;
  let failed = 0;

  for (const evalCase of cases) {
    process.stdout.write(`  ${evalCase.name}... `);

    try {
      const result = await runEval(context, evalCase);

      if (result.pass) {
        console.log("PASS");
        passed++;
      } else {
        console.log("FAIL");
        for (const err of result.errors) {
          console.log(`    - ${err}`);
        }
        failed++;
      }
    } catch (err) {
      console.log("ERROR");
      console.log(`    - ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed out of ${cases.length}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
