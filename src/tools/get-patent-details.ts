import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EpoClient, OpsApiError } from "../epo-client.js";
import { DocNumber, DocType, type FormatCandidate } from "../doc-number.js";
import { parseBiblio, type PatentBiblio } from "../parsers.js";
import { wrapJsonTool } from "../helpers.js";
import { resolveAndFetch } from "../fallback.js";
import { documentNumberParam } from "./params.js";

// OPS answers an unknown number with an exchange-document that has no
// bibliographic content. Returning that as a record made "not found" look
// like "a patent with no title", which agents then cited.
function isStub(b: PatentBiblio) {
  return !b.title && !b.abstract && b.applicants.length === 0 && !b.applicationNumber;
}

function dedupe(records: PatentBiblio[]) {
  const seen = new Set<string>();
  return records.filter((r) => {
    const key = `${r.publicationNumber}|${r.kindCode ?? ""}|${r.publicationDate ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Compare requested and returned numbers without dots, spaces or a kind suffix.
function baseNumber(s: string) {
  return s.replace(/[^A-Za-z0-9]/g, "").toUpperCase().replace(/(?<=\d)[A-Z]\d?$/, "");
}

type PubEntry = { requested: string; first: FormatCandidate };
type OkEntry = { requested: string };

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
    const allBiblio: PatentBiblio[] = [];
    const resolvedRequested = new Set<string>();
    const parseFailures: { number: string; reason: string }[] = [];
    const pubs: PubEntry[] = [];
    const recoverable: OkEntry[] = [];

    for (const d of document_numbers) {
      try {
        const doc = new DocNumber(d);
        recoverable.push({ requested: d });
        if (doc.type === DocType.Publication) {
          pubs.push({ requested: d, first: doc.formatCandidates()[0] });
        }
      } catch (e) {
        parseFailures.push({ number: d, reason: e instanceof Error ? e.message : String(e) });
      }
    }

    // The multi-number endpoint is unreliable: one unknown number fails the
    // whole request, and pairs of US grants are refused outright. Try it per
    // first-candidate format in chunks of 20; applications and parse failures
    // skip this and are recovered individually below.
    for (const fmt of [...new Set(pubs.map((e) => e.first.format))]) {
      const nums = pubs.filter((e) => e.first.format === fmt).map((e) => e.first.number);
      for (let i = 0; i < nums.length; i += 20) {
        const chunk = nums.slice(i, i + 20);
        try {
          allBiblio.push(...parseBiblio(await client.getBiblioMulti(chunk, fmt)).filter((b) => !isStub(b)));
        } catch {
          // recovered per number below
        }
      }
    }

    const have = () => new Set(allBiblio.map((b) => baseNumber(b.publicationNumber)));
    for (const e of pubs) {
      if (have().has(baseNumber(e.requested)) || have().has(baseNumber(e.first.number))) {
        resolvedRequested.add(e.requested);
      }
    }

    // Last resort (cap 40): resolveAndFetch walks remaining spellings on 404.
    // Previously also treated an empty/stub biblio body (HTTP 200, no content)
    // as a miss so the next spelling would be tried; that check was removed.
    const missing = recoverable.filter((e) => !resolvedRequested.has(e.requested));
    for (const e of missing.slice(0, 40)) {
      try {
        const { raw } = await resolveAndFetch(client, e.requested, (d, f) =>
          client.getBiblio(d, f)
        );
        allBiblio.push(...parseBiblio(raw).filter((b) => !isStub(b)));
        resolvedRequested.add(e.requested);
      } catch {
        // leave unresolved
      }
    }

    const results = dedupe(allBiblio);
    const notFound = document_numbers.filter((d) => !resolvedRequested.has(d));
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

  // Single mode:resolveAndFetch retries on 404 with docdb/kind spellings.
  try {
    const { raw, resolvedAs } = await resolveAndFetch(client, document_number, (d, f) =>
      client.getBiblio(d, f)
    );
    const records = dedupe(parseBiblio(raw).filter((b) => !isStub(b)));
    if (records.length === 0) {
      return {
        found: false,
        documentNumber: document_number,
        note: `OPS returned no bibliographic data for ${document_number}. Do not cite it as existing. Add a kind code (e.g. "EP.1393417.B1") or verify with search_patents(query='pn="${document_number}"', count_only=true).`,
      };
    }
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

Document number formats:
  epodoc: "EP1000000", "US2020001234", "WO2023123456"
  docdb: "EP.1000000.A1" (country.number.kind — more precise)

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
