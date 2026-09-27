import { EpoClient, OpsApiError } from "./epo-client.js";
import { DocNumber, DocType, OpsFormat, type FormatCandidate } from "./doc-number.js";
import { parseBiblio } from "./parsers.js";

export type Fetcher = (docNum: string, fmt: OpsFormat) => Promise<string>;

export type ResolvedCandidates = {
  input: string;
  candidates: FormatCandidate[];
  tried: string[];
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
