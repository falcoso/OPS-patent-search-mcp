import { EpoClient, OpsApiError } from "./epo-client.js";
import { DocNumber, DocType, OpsFormat, type FormatCandidate } from "./doc-number.js";
import { parseBiblio, type PatentBiblio } from "./parsers.js";

export { OpsFormat } from "./doc-number.js";
export type { FormatCandidate } from "./doc-number.js";

export type Fetcher = (docNum: string, fmt: OpsFormat) => Promise<string>;

export type ResolvedCandidates = {
  input: string;
  candidates: FormatCandidate[];
  tried: string[];
};

export type FamilyResult = {
  raw: string;
  resolvedAs: string;
  light: boolean;
};

export type BiblioBatchResult = {
  records: PatentBiblio[];
  notFound: string[];
  parseFailures: { number: string; reason: string }[];
};

/** 404 or OPS "ambiguous" — try the next spelling; anything else is fatal. */
function shouldTryNext(e: unknown): e is OpsApiError {
  return (
    e instanceof OpsApiError &&
    (e.status === 404 || /ambiguous/i.test(e.message))
  );
}

function exhausted(
  firstError: OpsApiError | null,
  fallbackMessage: string,
  tried: string[]
): never {
  const err = firstError ?? new OpsApiError(404, fallbackMessage);
  throw new OpsApiError(
    err.status,
    `${err.message} Tried: ${tried.join(", ")}.`,
    err.code
  );
}

/**
 * Build docdb publication candidates from application biblio records, in OPS order.
 * publicationNumber is epodoc form (e.g. EP1393417); kindCode supplies the kind.
 */
function publicationsFromApplicationBiblio(raw: string): FormatCandidate[] {
  const out: FormatCandidate[] = [];
  for (const b of parseBiblio(raw)) {
    if (!b.kindCode) continue;
    const m = b.publicationNumber.match(/^([A-Z]{2})(\d+)/i);
    if (!m) continue;
    out.push({
      number: `${m[1].toUpperCase()}.${m[2]}.${b.kindCode}`,
      format: OpsFormat.Docdb,
    });
  }
  return out;
}

/**
 * Parse a document number once and, for applications, look up linked publications
 * via getApplicationBiblio. Returns the ordered publication candidates to try.
 */
export async function resolveCandidates(
  client: EpoClient,
  documentNumber: string
): Promise<ResolvedCandidates> {
  const doc = new DocNumber(documentNumber);
  const tried: string[] = [];
  let firstError: OpsApiError | null = null;

  if (doc.type === DocType.Publication) {
    return { input: doc.input, candidates: doc.formatCandidates(), tried };
  }

  let candidates: FormatCandidate[] = [];
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
    exhausted(
      firstError,
      `No publications found for application ${doc.input}`,
      tried
    );
  }
  return { input: doc.input, candidates, tried };
}

/**
 * Walk resolved candidates with the fetcher; retry on 404 / ambiguous.
 */
export async function fetchFirst(
  resolved: ResolvedCandidates,
  fetcher: Fetcher
): Promise<{ raw: string; resolvedAs: string; format: OpsFormat }> {
  const tried = [...resolved.tried];
  let firstError: OpsApiError | null = null;

  for (const c of resolved.candidates) {
    tried.push(`${c.format}:${c.number}`);
    try {
      const raw = await fetcher(c.number, c.format);
      return { raw, resolvedAs: c.number, format: c.format };
    } catch (e) {
      if (!shouldTryNext(e)) throw e;
      if (!firstError) firstError = e;
    }
  }

  exhausted(firstError, `Document not found: ${resolved.input}`, tried);
}

/**
 * Resolve a document number to an OPS spelling that the fetcher accepts.
 * Applications are mapped to publications via getApplicationBiblio first.
 * Tries each candidate on 404 / ambiguous; other errors are rethrown.
 */
export async function resolveAndFetch(
  client: EpoClient,
  documentNumber: string,
  fetcher: Fetcher
): Promise<{ raw: string; resolvedAs: string; format: OpsFormat }> {
  return fetchFirst(await resolveCandidates(client, documentNumber), fetcher);
}

/**
 * Fetch a patent family, resolving format/kind (and application → publication).
 * On OPS "smaller chunks" (very large families), retries the light (no-biblio) variant.
 */
export async function getFamily(
  client: EpoClient,
  documentNumber: string
): Promise<FamilyResult> {
  return getFamilyFromResolved(
    client,
    await resolveCandidates(client, documentNumber)
  );
}

/** Same as getFamily but reuses already-resolved candidates. */
export async function getFamilyFromResolved(
  client: EpoClient,
  resolved: ResolvedCandidates
): Promise<FamilyResult> {
  try {
    const { raw, resolvedAs } = await fetchFirst(resolved, (d, f) =>
      client.getFamily(d, f)
    );
    return { raw, resolvedAs, light: false };
  } catch (e) {
    if (e instanceof OpsApiError && e.message.includes("smaller chunks")) {
      const { raw, resolvedAs } = await fetchFirst(resolved, (d, f) =>
        client.getFamilyLight(d, f)
      );
      return { raw, resolvedAs, light: true };
    }
    throw e;
  }
}

// OPS answers an unknown number with an exchange-document that has no
// bibliographic content. Returning that as a record made "not found" look
// like "a patent with no title", which agents then cited.
export function isStub(b: PatentBiblio) {
  return !b.title && !b.abstract && b.applicants.length === 0 && !b.applicationNumber;
}

/** Biblio fetch that treats an all-stub body as 404 so the next spelling is tried. */
function biblioFetcher(client: EpoClient): Fetcher {
  return async (docNum, fmt) => {
    const raw = await client.getBiblio(docNum, fmt);
    const records = parseBiblio(raw);
    if (records.length === 0 || records.every(isStub)) {
      throw new OpsApiError(404, `Document not found: ${docNum}`);
    }
    return raw;
  };
}

/** Resolve and fetch biblio; stubs / empty bodies advance to the next spelling. */
export async function fetchBiblio(
  client: EpoClient,
  documentNumber: string
): Promise<{ raw: string; resolvedAs: string; format: OpsFormat }> {
  return resolveAndFetch(client, documentNumber, biblioFetcher(client));
}

// Compare requested and returned numbers without dots, spaces or a kind suffix.
function baseNumber(s: string) {
  return s.replace(/[^A-Za-z0-9]/g, "").toUpperCase().replace(/(?<=\d)[A-Z]\d?$/, "");
}

/**
 * Batch biblio fetch: multi-number endpoint in chunks, then per-number recovery.
 * Returns undeduped records; the tool owns response shaping (notes, counts).
 */
export async function fetchBiblioBatch(
  client: EpoClient,
  numbers: string[]
): Promise<BiblioBatchResult> {
  const allBiblio: PatentBiblio[] = [];
  const resolvedRequested = new Set<string>();
  const parseFailures: { number: string; reason: string }[] = [];
  const pubs: { requested: string; first: FormatCandidate }[] = [];
  const recoverable: string[] = [];

  for (const d of numbers) {
    try {
      const doc = new DocNumber(d);
      recoverable.push(d);
      if (doc.type === DocType.Publication) {
        pubs.push({ requested: d, first: doc.formatCandidates()[0] });
      }
    } catch (e) {
      parseFailures.push({
        number: d,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // The multi-number endpoint is unreliable: one unknown number fails the
  // whole request, and pairs of US grants are refused outright. Try it per
  // first-candidate format in chunks of 20; applications and parse failures
  // skip this and are recovered individually below.
  for (const fmt of [...new Set(pubs.map((e) => e.first.format))]) {
    const nums = pubs
      .filter((e) => e.first.format === fmt)
      .map((e) => e.first.number);
    for (let i = 0; i < nums.length; i += 20) {
      const chunk = nums.slice(i, i + 20);
      try {
        allBiblio.push(
          ...parseBiblio(await client.getBiblioMulti(chunk, fmt)).filter(
            (b) => !isStub(b)
          )
        );
      } catch {
        // recovered per number below
      }
    }
  }

  const have = new Set(allBiblio.map((b) => baseNumber(b.publicationNumber)));
  for (const e of pubs) {
    if (have.has(baseNumber(e.requested)) || have.has(baseNumber(e.first.number))) {
      resolvedRequested.add(e.requested);
    }
  }

  // Last resort (cap 40): fetchBiblio walks remaining spellings; success means
  // non-stub records came back.
  const missing = recoverable.filter((d) => !resolvedRequested.has(d));
  for (const d of missing.slice(0, 40)) {
    try {
      const { raw } = await fetchBiblio(client, d);
      allBiblio.push(...parseBiblio(raw).filter((b) => !isStub(b)));
      resolvedRequested.add(d);
    } catch {
      // leave unresolved
    }
  }

  return {
    records: allBiblio,
    notFound: numbers.filter((d) => !resolvedRequested.has(d)),
    parseFailures,
  };
}
