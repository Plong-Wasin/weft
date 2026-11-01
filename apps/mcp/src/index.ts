#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server";

const token = Bun.env.WEFT_TOKEN;
if (!token) {
  console.error("WEFT_TOKEN is required: set it to a personal API token");
  process.exit(1);
}
await createMcpServer({ apiUrl: Bun.env.WEFT_API_URL ?? "http://localhost:3000", token }).connect(new StdioServerTransport());
