#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createPostdomMcpServer, PostdomClient } from "./index.js";

const apiKey = process.env.POSTDOM_API_KEY;
if (!apiKey) throw new Error("POSTDOM_API_KEY is required");

const client = new PostdomClient({
  apiKey,
  baseUrl: process.env.POSTDOM_API_URL,
  agentIdentity: process.env.POSTDOM_AGENT_IDENTITY
});
// The Autopilot tools, before launch, only when asked for.
const server = createPostdomMcpServer(client, { autopilot: process.env.POSTDOM_MCP_AUTOPILOT === "1" });
await server.connect(new StdioServerTransport());
