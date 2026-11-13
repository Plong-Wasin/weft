import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server";

async function toolNames(integrations: boolean) {
  const server = createMcpServer({ apiUrl: "http://localhost", token: "weft_unused", integrations });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return (await client.listTools()).tools.map((tool) => tool.name);
}

test("MCP offers the integration tools only when the flag is on", async () => {
  const off = await toolNames(false);
  expect(off).not.toContain("list_work_item_pull_requests");
  expect(off).not.toContain("create_work_item_integration");
  expect(off).toContain("create_work_item");
  const on = await toolNames(true);
  expect(on).toContain("list_work_item_pull_requests");
  expect(on).toContain("create_work_item_integration");
});
