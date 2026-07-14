#!/usr/bin/env tsx

import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { cases } from "./cases.js";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY is required to run evals.");
  console.error("Usage: ANTHROPIC_API_KEY=sk-... pnpm eval");
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey });

// Get tool schemas from our MCP server
async function getToolSchemas() {
  const server = createServer({
    apiKey: "eval-key",
    defaultSiteId: "example.com",
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "eval-client", version: "0.0.1" });
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  await client.close();

  // Convert MCP tool schemas to Anthropic tool format
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
  }));
}

async function runEval(
  tools: Anthropic.Tool[],
  evalCase: (typeof cases)[0]
): Promise<{ pass: boolean; errors: string[] }> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    system:
      "You are a marketing analytics assistant. When the user asks about website analytics, use the available tools. Always specify the site_id as 'example.com' unless told otherwise.",
    messages: [{ role: "user", content: evalCase.prompt }],
    tools,
    tool_choice: { type: "any" },
  });

  const toolUse = response.content.find(
    (block) => block.type === "tool_use"
  ) as Anthropic.ToolUseBlock | undefined;

  if (!toolUse) {
    return { pass: false, errors: ["No tool_use block in response"] };
  }

  const errors: string[] = [];

  if (toolUse.name !== evalCase.expectedTool) {
    errors.push(
      `Wrong tool: expected "${evalCase.expectedTool}", got "${toolUse.name}"`
    );
  }

  const assertionErrors = evalCase.assertions(
    toolUse.input as Record<string, unknown>
  );
  errors.push(...assertionErrors);

  return { pass: errors.length === 0, errors };
}

// Main
async function main() {
  console.log("Loading tool schemas from MCP server...\n");
  const tools = await getToolSchemas();
  console.log(`Found ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}\n`);

  let passed = 0;
  let failed = 0;

  for (const evalCase of cases) {
    process.stdout.write(`  ${evalCase.name}... `);

    try {
      const result = await runEval(tools, evalCase);

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
