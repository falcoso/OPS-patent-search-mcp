/**
 * Parse and respell patent document numbers for EPO OPS.
 */

export const OpsFormat = {
  Epodoc: "epodoc",
  Docdb: "docdb",
} as const;

export type OpsFormat = (typeof OpsFormat)[keyof typeof OpsFormat];

export type FormatCandidate = { number: string; format: OpsFormat };

export const DocType = {
  Publication: "publication",
  Application: "application",
} as const;

export type DocType = (typeof DocType)[keyof typeof DocType];

const ACCEPTED_SHAPES =
  'Accepted shapes include publications such as "EP1393417", "EP.1393417.B1", "US 2024/0318857 A1", "WO 2020/123456"; ' +
  'and applications such as "EP02729749", "EP20020729749", "US 16/123,456", "PCT/US2020/012345".';

const KIND = "([A-Z]\\d?)";
const KIND_FALLBACKS = ["A1", "B1", "A2", "B2", "A", "B"] as const;

function fail(input: string): never {
  throw new Error(`Cannot parse document number "${input}". ${ACCEPTED_SHAPES}`);
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

export class DocNumber {
  readonly type: DocType;
  readonly country: string;
  /** Digits only (no country/kind). US pubs keep mid-string zeros. */
  readonly number: string;
  readonly kind?: string;
  readonly input: string;
  /** EP app year when taken from EP{yyyy}{serial7}. */
  readonly year?: string;
  /** EP app check digit (epodoc only). */
  readonly checkDigit?: string;
  /** PCT filing office, e.g. US in PCT/US2020/012345. */
  readonly pctOffice?: string;
  /** US series/serial application: the series number (e.g. "16"). */
  readonly series?: string;

  /** Throws if the input does not match a recognised shape. */
  constructor(raw: string) {
    const input = raw.trim();
    if (!input) fail(raw);

    const s = input.toUpperCase().replace(/\s+/g, " ").trim();

    // --- Applications (punctuation decides before it is stripped) ---

    // PCT/US2020/012345
    {
      const m = s.match(/^PCT\/([A-Z]{2})(\d{4})\/(\d+)$/);
      if (m) {
        this.type = DocType.Application;
        this.country = "WO";
        this.pctOffice = m[1];
        this.year = m[2];
        this.number = m[3];
        this.input = input;
        return;
      }
    }

    // EP20020729749 — YYYY + 7-digit serial (epodoc). Short/docdb form is
    // YY + 6-digit serial: year 2002 + 0729749 ↔ 02729749.
    {
      const m = s.match(/^EP\s*?(19|20)(\d{2})(\d{7})$/);
      if (m) {
        const year = m[1] + m[2];
        const serial7 = m[3];
        const serial6 = serial7.startsWith("0") ? serial7.slice(1) : serial7;
        this.type = DocType.Application;
        this.country = "EP";
        this.year = year;
        this.number = year.slice(2) + serial6; // 8-digit short / docdb form
        this.input = input;
        return;
      }
    }

    // EP02729749 or EP02729749.3 — 8-digit serial, optional check digit
    {
      const m = s.match(/^EP\s*?(\d{8})(?:\.(\d))?$/);
      if (m) {
        this.type = DocType.Application;
        this.country = "EP";
        this.number = m[1];
        if (m[2] !== undefined) this.checkDigit = m[2];
        this.input = input;
        return;
      }
    }

    // US 16/123,456 — series/serial (1–2 digit series, not a 4-digit year)
    {
      const m = s.match(/^US\s*?(\d{1,2})\/([\d,]+)$/);
      if (m) {
        this.type = DocType.Application;
        this.country = "US";
        this.series = m[1];
        this.number = digitsOnly(m[2]);
        this.input = input;
        return;
      }
    }

    // --- Publications ---
    // Applications that needed punctuation for classification already returned.
    // Strip remaining punctuation and match compact CC + digits + optional kind.
    {
      const compact = s.replace(/[^A-Z0-9]/g, "");
      const m = compact.match(new RegExp(`^([A-Z]{2})(\\d+)${KIND}?$`));
      if (m) {
        this.type = DocType.Publication;
        this.country = m[1];
        this.number = m[2];
        if (m[3]) this.kind = m[3];
        this.input = input;
        return;
      }
    }

    fail(input);
  }

  /** Epodoc spelling, e.g. EP1393417 or EP1393417B1 when kind is known. Throws if application. */
  epodoc(): string {
    if (this.type !== DocType.Publication) {
      throw new Error(`epodoc() expects a publication, got ${this.type}`);
    }
    return this.kind
      ? `${this.country}${this.number}${this.kind}`
      : `${this.country}${this.number}`;
  }

  /**
   * Docdb spelling, e.g. EP.1393417.B1 (kind included when known) or EP.1393417.
   * Throws if this is an application number.
   */
  docdb(): string {
    if (this.type !== DocType.Publication) {
      throw new Error(`docdb() expects a publication, got ${this.type}`);
    }
    return this.kind
      ? `${this.country}.${this.number}.${this.kind}`
      : `${this.country}.${this.number}`;
  }

  /**
   * Ordered publication spellings to try against OPS publication endpoints.
   * US application-publication numbers keep mid-string zeros as parsed.
   */
  formatCandidates(): FormatCandidate[] {
    if (this.type !== DocType.Publication) {
      throw new Error(`formatCandidates expects a publication, got ${this.type}`);
    }
    if (this.kind) {
      return [
        { number: this.docdb(), format: OpsFormat.Docdb },
        { number: this.epodoc(), format: OpsFormat.Epodoc },
      ];
    }
    return [
      { number: this.epodoc(), format: OpsFormat.Epodoc },
      ...KIND_FALLBACKS.map((k) => ({
        number: `${this.country}.${this.number}.${k}`,
        format: OpsFormat.Docdb,
      })),
    ];
  }

  /**
   * Ordered spellings for the OPS application biblio endpoint.
   * Never emits a PCT/… path (slashes break the URL).
   */
  applicationCandidates(): FormatCandidate[] {
    if (this.type !== DocType.Application) {
      throw new Error(`applicationCandidates expects an application, got ${this.type}`);
    }

    if (this.pctOffice && this.year) {
      const { year, pctOffice, number } = this;
      return [
        { number: `WO${year}${pctOffice}${number}`, format: OpsFormat.Epodoc },
        { number: `${pctOffice}${year}${number}`, format: OpsFormat.Epodoc },
        { number: `WO.${year}${pctOffice}${number}`, format: OpsFormat.Docdb },
      ];
    }

    if (this.country === "EP") {
      const serial8 = this.number;
      const out: FormatCandidate[] = [];
      if (this.year) {
        // YYYY + 0 + 6-digit serial (from YY + 6-digit short form)
        const serial6 = serial8.slice(2);
        const serial7 = "0" + serial6;
        out.push({ number: `EP${this.year}${serial7}`, format: OpsFormat.Epodoc });
        out.push({ number: `EP.${this.year}${serial7}`, format: OpsFormat.Docdb });
      }
      out.push({ number: `EP${serial8}`, format: OpsFormat.Epodoc });
      if (this.checkDigit !== undefined) {
        out.push({ number: `EP${serial8}.${this.checkDigit}`, format: OpsFormat.Epodoc });
      }
      out.push({ number: `EP.${serial8}`, format: OpsFormat.Docdb });
      return out;
    }

    if (this.country === "US" && this.series !== undefined) {
      return [{ number: `US${this.series}${this.number}`, format: OpsFormat.Epodoc }];
    }

    return [{ number: `${this.country}${this.number}`, format: OpsFormat.Epodoc }];
  }
}
