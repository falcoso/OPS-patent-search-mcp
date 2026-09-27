import { EpoClient, OpsApiError } from "./epo-client.js";
import { DocNumber, DocType, OpsFormat, type FormatCandidate } from "./doc-number.js";
import { parseBiblio, parseFamilyMembers } from "./parsers.js";

/** 404 or OPS "ambiguous" — try the next spelling; anything else is fatal. */
function shouldTryNext(e: unknown): e is OpsApiError {
  return (
    e instanceof OpsApiError &&
    (e.status === 404 || /ambiguous/i.test(e.message))
  );
}

/** Build docdb publication candidates from application biblio records, in OPS order. */
function publicationsFromApplicationBiblio(raw: string): FormatCandidate[] {
  const out: FormatCandidate[] = [];
  for (const b of parseBiblio(raw)) {
    if (!b.kindCode) continue;
    try {
      const doc = new DocNumber(`${b.publicationNumber}${b.kindCode}`);
      if (doc.type !== DocType.Publication) continue;
      out.push({ number: doc.docdb(), format: OpsFormat.Docdb });
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Resolve a document number to an OPS spelling that the fetcher accepts.
 * Applications are mapped to publications via getApplicationBiblio first.
 * Tries each candidate on 404 / ambiguous; other errors are rethrown.
 */
export async function resolveAndFetch(
  client: EpoClient,
  documentNumber: string,
  fetcher: (docNum: string, fmt: string) => Promise<string>
): Promise<{ raw: string; resolvedAs: string; format: OpsFormat }> {
  const doc = new DocNumber(documentNumber);
  const tried: string[] = [];
  let firstError: OpsApiError | null = null;
  let candidates: FormatCandidate[];

  if (doc.type === DocType.Publication) {
    candidates = doc.formatCandidates();
  } else {
    candidates = [];
    for (const c of doc.applicationCandidates()) {
      tried.push(`${c.format}:${c.number}`);
      try {
        const appRaw = await client.getApplicationBiblio(c.number, c.format);
        candidates = publicationsFromApplicationBiblio(appRaw);
        if (candidates.length > 0) break;
      } catch (e) {
        if (!shouldTryNext(e)) throw e;
        if (!firstError) firstError = e;
      }
    }
    if (candidates.length === 0) {
      const err =
        firstError ??
        new OpsApiError(404, `No publications found for application ${doc.input}`);
      throw new OpsApiError(
        err.status,
        `${err.message} Tried: ${tried.join(", ")}.`,
        err.code
      );
    }
  }

  for (const c of candidates) {
    tried.push(`${c.format}:${c.number}`);
    try {
      const raw = await fetcher(c.number, c.format);
      return { raw, resolvedAs: c.number, format: c.format };
    } catch (e) {
      if (!shouldTryNext(e)) throw e;
      if (!firstError) firstError = e;
    }
  }

  const err =
    firstError ?? new OpsApiError(404, `Document not found: ${doc.input}`);
  throw new OpsApiError(
    err.status,
    `${err.message} Tried: ${tried.join(", ")}.`,
    err.code
  );
}

/**
 * Fetch a patent family, resolving format/kind (and application → publication)
 * via resolveAndFetch. Pass light=true for the no-biblio variant used when OPS
 * refuses a large family with "smaller chunks".
 */
export async function getFamilyWithFormatFallback(
  client: EpoClient,
  documentNumber: string,
  light = false
): Promise<{ raw: string; resolvedAs: string; format: OpsFormat }> {
  return resolveAndFetch(client, documentNumber, (d, f) =>
    light ? client.getFamilyLight(d, f) : client.getFamily(d, f)
  );
}

/**
 * Try to fetch fulltext (claims or description) for a document.
 * Resolves format/kind/application via resolveAndFetch first. If that
 * returns 404, fetch the patent family and try EP/WO members first
 * (most reliably indexed in OPS), then others.
 * Returns the raw JSON, the document that succeeded, and whether a
 * family substitution was made.
 */
export async function fetchWithFamilyFallback(
  client: EpoClient,
  documentNumber: string,
  fetcher: (docNum: string, fmt: string) => Promise<string>
): Promise<{ raw: string; resolvedDocument: string; substituted: boolean }> {
  try {
    const { raw, resolvedAs } = await resolveAndFetch(client, documentNumber, fetcher);
    return { raw, resolvedDocument: resolvedAs, substituted: false };
  } catch (e) {
    if (!(e instanceof OpsApiError) || e.status !== 404) throw e;
  }

  // Still 404 — try the patent family
  let familyRaw: string;
  try {
    familyRaw = (await getFamilyWithFormatFallback(client, documentNumber)).raw;
  } catch (e) {
    // Very large families (Xencor, Immunomedics) are refused with "smaller
    // chunks"; the light variant still lists members, which is all we need.
    if (e instanceof OpsApiError && e.message.includes("smaller chunks")) {
      try {
        familyRaw = (await getFamilyWithFormatFallback(client, documentNumber, true)).raw;
      } catch {
        throw new OpsApiError(
          404,
          `Full text not available for ${documentNumber} and could not retrieve patent family for fallback.`
        );
      }
    } else {
      throw new OpsApiError(
        404,
        `Full text not available for ${documentNumber} and could not retrieve patent family for fallback.`
      );
    }
  }

  const members = parseFamilyMembers(familyRaw);
  if (members.length === 0) {
    throw new OpsApiError(
      404,
      `Full text not available for ${documentNumber} and no family members found.`
    );
  }

  // Prioritise offices most likely to have full text in OPS
  const priority = ["EP", "WO", "GB", "DE", "FR"];
  const sorted = [...members].sort((a, b) => {
    const ai = priority.indexOf(a.country);
    const bi = priority.indexOf(b.country);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  for (const member of sorted) {
    if (!member.kind || !member.rawNumber) continue;
    // Docdb format expected by OPS: CC.number.KK  e.g. EP.3750919.A1
    const docdbNum = `${member.country}.${member.rawNumber}.${member.kind}`;
    try {
      const raw = await fetcher(docdbNum, "docdb");
      return { raw, resolvedDocument: docdbNum, substituted: true };
    } catch {
      // try next member
    }
  }

  throw new OpsApiError(
    404,
    `Full text not available for ${documentNumber} or any of its ${members.length} family member(s). ` +
      `Family includes: ${members
        .slice(0, 8)
        .map((m) => m.publicationNumber)
        .join(", ")}${members.length > 8 ? "…" : ""}.`
  );
}

/** Note when full text was taken from a family member rather than the requested document. */
export function substitutionNote(
  requested: string,
  resolved: string,
  section: "claims" | "description",
  empty: boolean
): string {
  if (empty) {
    return section === "claims"
      ? `Full text not available for ${requested}. Attempted family member ${resolved} but it also returned no claims. Granted patent claims (B1/B2 kind codes) are often not available via OPS. Check Espacenet web or USPTO PAIR for granted claim text.`
      : `Full text not available for ${requested}. Attempted family member ${resolved} but it also returned no description. Granted patents (B1/B2) often lack full text in OPS. Try the A1/A2 version or check Espacenet web.`;
  }
  return `Full text not available for ${requested}. Showing ${section} from family member ${resolved}.`;
}
