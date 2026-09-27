import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EpoClient, OpsApiError } from "../epo-client.js";
import { parseBiblio, type PatentBiblio } from "../parsers.js";
import { wrapJsonTool } from "../helpers.js";
import { fetchBiblio, fetchBiblioBatch, isStub } from "../resolve.js";
import { documentNumberParam } from "./params.js";

function dedupe(records: PatentBiblio[]) {
  const seen = new Set<string>();
  return records.filter((r) => {
    const key = `${r.publicationNumber}|${r.kindCode ?? ""}|${r.publicationDate ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type GetPatentDetailsArgs = {
  document_number: string;
  document_numbers?: string[];
};

export async function getPatentDetails(
  client: EpoClient,
  { document_number, document_numbers }: GetPatentDetailsArgs,
) {
  client.startToolCall();

  // Batch mode
  if (document_numbers && document_numbers.length > 0) {
    const { records, notFound, parseFailures } = await fetchBiblioBatch(
      client,
      document_numbers
    );
    const results = dedupe(records);
    const notes: string[] = [];
    if (parseFailures.length > 0) {
      notes.push(
        `${parseFailures.length} number(s) could not be parsed: ${parseFailures.map((p) => `${p.number} (${p.reason})`).join("; ")}.`
      );
    }
    const unresolved = notFound.filter((d) => !parseFailures.some((p) => p.number === d));
    if (unresolved.length > 0) {
      notes.push(
        `${unresolved.length} of ${document_numbers.length} numbers returned no bibliographic record: ${unresolved.join(", ")}. Do not cite them as existing. SPC/certificate numbers (kind I1/I2/C1) have no bibliographic record — look up the basic patent instead.`
      );
    }
    return {
      requested: document_numbers.length,
      found: document_numbers.length - notFound.length,
      results,
      notFound,
      ...(notes.length > 0 && { note: notes.join(" ") }),
    };
  }

  // Single mode: fetchBiblio treats stub/empty bodies as 404.
  try {
    const { raw, resolvedAs } = await fetchBiblio(client, document_number);
    const records = dedupe(parseBiblio(raw).filter((b) => !isStub(b)));
    if (resolvedAs !== document_number) {
      return {
        results: records,
        resolvedAs,
        note: `Resolved ${document_number} as ${resolvedAs}.`,
      };
    }
    return records;
  } catch (e) {
    if (e instanceof OpsApiError && e.status === 404) {
      return {
        found: false,
        documentNumber: document_number,
        note: `OPS returned no bibliographic data for ${document_number}. Do not cite it as existing. Add a kind code or verify with search_patents(query='pn="${document_number}"', count_only=true).`,
      };
    }
    throw e;
  }
}

export function registerGetPatentDetails(server: McpServer, client: EpoClient) {
  server.registerTool(
    "get_patent_details",
    {
      description: `Retrieve full details for a specific patent: title, abstract, applicants, inventors, IPC/CPC classifications, publication/application dates, and priority claims.

IMPORTANT — LEGAL: Only present data returned by this tool. Never fabricate or guess patent metadata. Always include publication numbers when citing results.

Use this when you already have a publication number and need its details. For searching by topic or applicant, use search_patents instead.

Accepts common written forms (publication or application; kind code optional), e.g. "EP1393417", "EP.1393417.B1", "US 2024/0318857 A1", "EP02729749", "PCT/US2020/012345". Including a kind code selects that exact publication stage; without one, all stages for the number may be returned.

Response: one record per publication stage of the number, each with kindCode (A1/A2 = application, B1/B2 = grant). A number with an A1 and a B1 publication therefore returns two records with different publicationDate values. When the input was respelled or resolved from an application number, resolvedAs is included.

Batch mode: pass document_numbers (array of up to 100 numbers) to retrieve multiple patents in one call. When using batch mode, document_number is ignored. The batch response is an object: { requested, found, results, notFound }. notFound lists the requested numbers that returned no bibliographic record after all retries, so a missing patent is never silent. Keep batches to about 10 numbers when you need abstracts: 13 full records already exceed the client's 25K-token result limit and get redirected to a file. SPC and certificate numbers (kind I1/I2/C1) have no bibliographic record; look up the basic patent instead.`,
      inputSchema: {
        document_number: documentNumberParam.default("").describe(
          'Patent publication or application number, e.g. "EP1393417" or "EP02729749". Ignored when document_numbers is provided.'
        ),
        document_numbers: z
          .array(z.string())
          .max(100)
          .optional()
          .describe('Batch mode: array of patent numbers to retrieve in one call (max 100). More efficient than calling one at a time.'),
      },
      annotations: { readOnlyHint: true },
    },
    wrapJsonTool(client, getPatentDetails, { grounding: true }),
  );
}
