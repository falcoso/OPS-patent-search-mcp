import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EpoClient } from "../epo-client.js";
import { parseFulltextParagraphs, paginateParagraphs } from "../parsers.js";
import { wrapJsonTool } from "../helpers.js";
import { fetchWithFamilyFallback, substitutionNote } from "../fallback.js";
import { documentNumberParam, inputFormatParam, fallbackToFamilyParam } from "./params.js";

type FulltextSection = "claims" | "description";

type FulltextArgs = {
  document_number: string;
  input_format: string;
  offset: number;
  limit?: number;
  max_characters: number;
  fallback_to_family: boolean;
};

const EMPTY_NOTES: Record<FulltextSection, (doc: string) => string> = {
  claims: (doc) =>
    `No claims text found for ${doc}. Granted patent claims (B1/B2 kind codes) are often not indexed in OPS full text. Try requesting the A1/A2 (application) version instead, or use get_patent_family to find a WO equivalent. For definitive granted claims, check Espacenet web or USPTO PAIR.`,
  description: (doc) =>
    `No description text found for ${doc}. Granted patents (B1/B2) are often not indexed in OPS full text. Try the A1/A2 version, or use get_patent_family to find a WO equivalent.`,
};

export async function getFulltext(
  client: EpoClient,
  section: FulltextSection,
  fetcher: (docNum: string, fmt: string) => Promise<string>,
  { document_number, input_format, offset, limit, max_characters, fallback_to_family }: FulltextArgs,
) {
  client.startToolCall();
  const { raw, resolvedDocument, substituted } = fallback_to_family
    ? await fetchWithFamilyFallback(client, document_number, input_format, fetcher)
    : { raw: await fetcher(document_number, input_format), resolvedDocument: document_number, substituted: false };

  const paragraphs = parseFulltextParagraphs(raw);
  const result = paginateParagraphs(paragraphs, offset, limit, max_characters);

  if (substituted) {
    const note = substitutionNote(document_number, resolvedDocument, section, result.totalParagraphs === 0);
    return { ...result, note, resolvedDocument };
  }
  if (result.totalParagraphs === 0) {
    return {
      ...result,
      note: EMPTY_NOTES[section](document_number),
    };
  }
  return result;
}

export async function getPatentClaims(client: EpoClient, args: FulltextArgs) {
  return getFulltext(client, "claims", (d, f) => client.getClaims(d, f), args);
}

export async function getPatentDescription(client: EpoClient, args: FulltextArgs) {
  return getFulltext(client, "description", (d, f) => client.getDescription(d, f), args);
}

function registerFulltextReader(
  server: McpServer,
  client: EpoClient,
  section: FulltextSection,
  fetcher: (client: EpoClient, args: FulltextArgs) => Promise<unknown>,
  description: string,
  maxCharactersDescribe: string
) {
  server.registerTool(
    section === "claims" ? "get_patent_claims" : "get_patent_description",
    {
      description,
      inputSchema: {
        document_number: documentNumberParam,
        input_format: inputFormatParam.describe('Number format. Try "docdb" with kind code if epodoc fails for fulltext.'),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Paragraph index to start from (0-based). Use next_offset from previous response to continue."),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Max paragraphs to return. Omit to return all (subject to max_characters)."),
        max_characters: z
          .number()
          .int()
          .min(100)
          .default(10000)
          .describe(maxCharactersDescribe),
        fallback_to_family: fallbackToFamilyParam,
      },
      annotations: { readOnlyHint: true },
    },
    wrapJsonTool(client, fetcher, { grounding: true }),
  );
}

export function registerGetPatentClaims(server: McpServer, client: EpoClient) {
  registerFulltextReader(
    server,
    client,
    "claims",
    getPatentClaims,
    `Read the claims of a patent with pagination support. Claims define the legal scope of the patent.

IMPORTANT — LEGAL: Only quote or summarize text returned by this tool. Never fabricate claim language.

Full text is available primarily for EP, WO, and US patents. If you get a "not available" error, try docdb format with a kind code (e.g. "EP.1000000.A1").

When fallback_to_family is true (default), a 404 will automatically trigger a family lookup and retry against the best available EP/WO equivalent — useful when US or other national documents lack full text in OPS.

Use offset/limit/max_characters to control how much text is returned. The response includes next_offset — pass it as offset in your next call to continue reading.

Recommended: use search_in_patent_text first to find relevant claim numbers, then read around those locations with offset.`,
    "Max characters to return (default 10000). Set higher for full claims."
  );
}

export function registerGetPatentDescription(server: McpServer, client: EpoClient) {
  registerFulltextReader(
    server,
    client,
    "description",
    getPatentDescription,
    `Read the description/specification of a patent with pagination. Descriptions can be 50,000-100,000+ characters.

IMPORTANT — LEGAL: Only quote or summarize text returned by this tool. Never fabricate patent description content.

Do NOT call this without pagination parameters — it will return too much text. Always set max_characters (default 10000) or limit.

When fallback_to_family is true (default), a 404 will automatically trigger a family lookup and retry against the best available EP/WO equivalent — useful when US or other national documents lack full text in OPS.

Recommended workflow:
1. First call search_in_patent_text to find where relevant content is located
2. Then call this with offset set to the sectionOffset from the search results (use matches where section="description")
3. Use next_offset from the response to continue reading if needed`,
    "Max characters to return (default 10000). Increase for longer reads, decrease for overview."
  );
}
