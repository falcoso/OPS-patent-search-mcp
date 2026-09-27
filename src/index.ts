#!/usr/bin/env node
/**
 * Patent Search MCP Server v2.0.0
 *
 * Patent search and retrieval via EPO Open Patent Services (OPS) API.
 * Designed for agentic use: keyword search + paginated reading prevent
 * dumping large patent texts into context.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSearchPatents } from "./tools/search-patents.js";
import { registerGetPatentDetails } from "./tools/get-patent-details.js";
import { registerGetPatentClaims, registerGetPatentDescription } from "./tools/fulltext.js";
import { registerSearchInPatentText } from "./tools/search-in-patent-text.js";
import { registerSearchAndFilterFulltext } from "./tools/search-and-filter.js";
import { registerGetPatentFamily } from "./tools/get-patent-family.js";
import { registerGetPatentLegalStatus } from "./tools/get-patent-legal-status.js";
import { registerGetPatentCitations } from "./tools/get-patent-citations.js";
import { createClient } from "./helpers.js";

const client = createClient();

const server = new McpServer({
  name: "ops-patent-search",
  version: "2.0.0",
});

registerSearchPatents(server, client);
registerGetPatentDetails(server, client);
registerGetPatentClaims(server, client);
registerGetPatentDescription(server, client);
registerSearchInPatentText(server, client);
registerSearchAndFilterFulltext(server, client);
registerGetPatentFamily(server, client);
registerGetPatentLegalStatus(server, client);
registerGetPatentCitations(server, client);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Patent Search MCP server v2.0.0 running on stdio");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
