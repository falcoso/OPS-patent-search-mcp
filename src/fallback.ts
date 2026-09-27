import { EpoClient, OpsApiError } from "./epo-client.js";
import { parseFamilyMembers } from "./parsers.js";
import {
  fetchFirst,
  getFamilyFromResolved,
  OpsFormat,
  resolveCandidates,
  type Fetcher,
} from "./resolve.js";

/**
 * Fetch fulltext (claims or description) for a document.
 * Resolves candidates once; on 404 with family=true, looks up the INPADOC
 * family with those same candidates and tries EP/WO members first.
 * Returns the raw JSON, the document that succeeded, and whether a
 * family substitution was made.
 */
export async function fetchFulltext(
  client: EpoClient,
  documentNumber: string,
  fetcher: Fetcher,
  { family }: { family: boolean }
): Promise<{ raw: string; resolvedAs: string; substituted: boolean }> {
  const resolved = await resolveCandidates(client, documentNumber);

  try {
    const { raw, resolvedAs } = await fetchFirst(resolved, fetcher);
    return { raw, resolvedAs, substituted: false };
  } catch (e) {
    if (!family || !(e instanceof OpsApiError) || e.status !== 404) throw e;
  }

  let familyRaw: string;
  try {
    familyRaw = (await getFamilyFromResolved(client, resolved)).raw;
  } catch {
    throw new OpsApiError(
      404,
      `Full text not available for ${documentNumber} and could not retrieve patent family for fallback.`
    );
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
      const raw = await fetcher(docdbNum, OpsFormat.Docdb);
      return { raw, resolvedAs: docdbNum, substituted: true };
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
