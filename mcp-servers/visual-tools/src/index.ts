#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerMermaidTools } from "./mermaid.js";
import { registerSvgTools } from "./svg.js";

const server = new McpServer({ name: "learn-visual-tools", version: "0.1.0" });

registerMermaidTools(server);
registerSvgTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
