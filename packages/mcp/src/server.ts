#!/usr/bin/env node
import { DemarkerClient } from "@demarker/client";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDemarkerServer } from "./tools.ts";

const VERSION = "0.1.1";

const ceiling = Number(process.env.DEMARKER_MCP_MAX_CREDITS ?? 2);
const client = new DemarkerClient({
	apiKey: process.env.DEMARKER_API_KEY || undefined,
	baseUrl: process.env.DEMARKER_API_URL || undefined,
	userAgent: `demarker-mcp/${VERSION}`,
});
const server = createDemarkerServer({
	client,
	version: VERSION,
	maxCreditsPerCall: Number.isFinite(ceiling) && ceiling >= 0 ? ceiling : 2,
});
await server.connect(new StdioServerTransport());
