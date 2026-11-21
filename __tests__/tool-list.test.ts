import { describe, it, expect } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../src/server.js";

// Agents choose tools and arguments from these words alone, and small wording changes can
// change their choices. A diff here means the change needs review and an eval run
// (`pnpm eval`) before it ships; update the snapshot with `pnpm test -u`.
describe("tool list snapshot", () => {
  it("matches the reviewed instructions, descriptions and schemas", async () => {
    const server = createServer({
      apiKey: "snapshot-key",
      defaultSiteId: "example.com",
      enableFeedbackTool: true,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "snapshot-client", version: "0.0.1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      expect({ instructions: client.getInstructions(), tools }).toMatchSnapshot();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
