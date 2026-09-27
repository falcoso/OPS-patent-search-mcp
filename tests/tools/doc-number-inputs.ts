import type { ToolResult, ToolTestSuite } from "../helpers.js";

/** EP1393417 — known to have A2 (application) and B1 (grant) stages. */
const EP_PUB = "EP1393417";
/** Application number linked to EP1393417 (from EP20020729749). */
const EP_APP = "EP 02729749";
/** Slash-formatted US application publication. */
const US_SLASH = "US 2024/0318857 A1";

function parsePayload(r: ToolResult): unknown {
  return JSON.parse(r.content[0].text);
}

/** Single-mode get_patent_details returns either a bare array or { results, resolvedAs }. */
function biblioRecords(data: unknown): Array<{ publicationNumber?: string; kindCode?: string }> {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && Array.isArray((data as { results?: unknown }).results)) {
    return (data as { results: Array<{ publicationNumber?: string; kindCode?: string }> }).results;
  }
  return [];
}

function kindsOf(data: unknown): Set<string> {
  return new Set(biblioRecords(data).map((b) => b.kindCode).filter((k): k is string => !!k));
}

/** Integration tests for messy / alternate document-number inputs. */
export const testDocNumberInputs: ToolTestSuite = async (_client, test) => {
  await test(
    "Details: plain EP1393417 returns A2 and B1",
    "get_patent_details",
    { document_number: EP_PUB },
    (r) => {
      const kinds = kindsOf(parsePayload(r));
      if (!kinds.has("A2")) return `Expected A2 stage, got kinds: ${[...kinds].join(",") || "(none)"}`;
      if (!kinds.has("B1")) return `Expected B1 stage, got kinds: ${[...kinds].join(",") || "(none)"}`;
      return null;
    }
  );

  await test(
    "Details: EP 1393417 B1 returns only B1",
    "get_patent_details",
    { document_number: "EP 1393417 B1" },
    (r) => {
      const records = biblioRecords(parsePayload(r));
      if (records.length === 0) return "Expected biblio records";
      const kinds = kindsOf(parsePayload(r));
      if (kinds.size !== 1 || !kinds.has("B1"))
        return `Expected only B1, got kinds: ${[...kinds].join(",") || "(none)"}`;
      return null;
    }
  );

  await test(
    "Details: EP1393417B1 returns only B1",
    "get_patent_details",
    { document_number: "EP1393417B1" },
    (r) => {
      const kinds = kindsOf(parsePayload(r));
      if (kinds.size !== 1 || !kinds.has("B1"))
        return `Expected only B1, got kinds: ${[...kinds].join(",") || "(none)"}`;
      return null;
    }
  );

  await test(
    "Details: EP.1393417.B1 returns only B1",
    "get_patent_details",
    { document_number: "EP.1393417.B1" },
    (r) => {
      const kinds = kindsOf(parsePayload(r));
      if (kinds.size !== 1 || !kinds.has("B1"))
        return `Expected only B1, got kinds: ${[...kinds].join(",") || "(none)"}`;
      return null;
    }
  );

  await test(
    "Details: slash-formatted US publication",
    "get_patent_details",
    { document_number: US_SLASH },
    (r) => {
      const records = biblioRecords(parsePayload(r));
      if (records.length === 0) return "Expected biblio records for US 2024/0318857 A1";
      const num = records[0].publicationNumber ?? "";
      if (!/US.?20240318857/i.test(num) && !/US.?2024.?0318857/i.test(num))
        return `Unexpected publicationNumber: ${num}`;
      return null;
    }
  );

  await test(
    "Description: slash-formatted US publication",
    "get_patent_description",
    { document_number: US_SLASH, max_characters: 3000 },
    (r) => {
      const data = parsePayload(r) as { paragraphs?: unknown[] };
      if (!Array.isArray(data.paragraphs) || data.paragraphs.length === 0)
        return "Expected description paragraphs";
      return null;
    }
  );

  await test(
    "Details: EP application resolves to EP1393417",
    "get_patent_details",
    { document_number: EP_APP },
    (r) => {
      const data = parsePayload(r) as {
        results?: Array<{ publicationNumber?: string }>;
        resolvedAs?: string;
      };
      if (!data.resolvedAs) return "Expected resolvedAs for application input";
      if (!/EP.?1393417/i.test(data.resolvedAs))
        return `resolvedAs should reference EP1393417, got: ${data.resolvedAs}`;
      const records = biblioRecords(data);
      if (records.length === 0) return "Expected biblio records after application resolve";
      if (!records.some((b) => /EP.?1393417/i.test(b.publicationNumber ?? "")))
        return "Expected a record for EP1393417";
      return null;
    }
  );

  await test(
    "Family: EP application resolves to EP1393417",
    "get_patent_family",
    { document_number: EP_APP, max_members: 10 },
    (r) => {
      const data = parsePayload(r) as {
        resolvedAs?: string;
        members?: Array<{ publicationNumber?: string }>;
        note?: string;
      };
      if (!data.resolvedAs && !data.note?.includes("Resolved"))
        return "Expected resolvedAs (or note) for application input";
      if (data.resolvedAs && !/EP.?1393417/i.test(data.resolvedAs))
        return `resolvedAs should reference EP1393417, got: ${data.resolvedAs}`;
      if (!Array.isArray(data.members) || data.members.length === 0)
        return "Expected family members";
      return null;
    }
  );

  await test(
    "Garbage input names accepted shapes",
    "get_patent_details",
    { document_number: "not-a-patent" },
    (r) => {
      const text = r.content[0].text;
      if (!/Cannot parse|Accepted shapes/i.test(text))
        return `Expected parse-error naming accepted shapes, got: ${text.slice(0, 200)}`;
      return null;
    },
    true /* ignoreIsError — error result is the expected outcome */
  );
};
