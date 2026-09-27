/**
 * Offline unit tests for DocNumber — no credentials, no API calls.
 *
 *   npx tsx tests/doc-number.ts
 *   npm run test:unit
 */

import assert from "node:assert/strict";
import { DocNumber, DocType, OpsFormat, type FormatCandidate } from "../src/doc-number.js";

type ExpectedFields = {
  type: DocType;
  country: string;
  number: string;
  kind?: string;
  year?: string;
  checkDigit?: string;
  pctOffice?: string;
  series?: string;
};

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e instanceof Error ? e.message : e}`);
  }
}

function assertFields(raw: string, expected: ExpectedFields) {
  const d = new DocNumber(raw);
  assert.equal(d.type, expected.type, "type");
  assert.equal(d.country, expected.country, "country");
  assert.equal(d.number, expected.number, "number");
  assert.equal(d.kind, expected.kind, "kind");
  assert.equal(d.year, expected.year, "year");
  assert.equal(d.checkDigit, expected.checkDigit, "checkDigit");
  assert.equal(d.pctOffice, expected.pctOffice, "pctOffice");
  assert.equal(d.series, expected.series, "series");
  assert.equal(d.input, raw.trim(), "input");
}

function assertCandidates(actual: FormatCandidate[], expected: FormatCandidate[]) {
  assert.deepEqual(actual, expected);
}

// --- parse: publications ---

console.log("parse publications");
const publications: Array<[string, ExpectedFields]> = [
  ["EP1393417", { type: DocType.Publication, country: "EP", number: "1393417" }],
  ["EP 1393417 B1", { type: DocType.Publication, country: "EP", number: "1393417", kind: "B1" }],
  ["EP1393417B1", { type: DocType.Publication, country: "EP", number: "1393417", kind: "B1" }],
  ["EP.1393417.B1", { type: DocType.Publication, country: "EP", number: "1393417", kind: "B1" }],
  ["EP-1393417-B1", { type: DocType.Publication, country: "EP", number: "1393417", kind: "B1" }],
  ["US 2024/0318857 A1", { type: DocType.Publication, country: "US", number: "20240318857", kind: "A1" }],
  ["US20240318857A1", { type: DocType.Publication, country: "US", number: "20240318857", kind: "A1" }],
  ["US 11,234,567 B2", { type: DocType.Publication, country: "US", number: "11234567", kind: "B2" }],
  ["WO 2020/123456 A1", { type: DocType.Publication, country: "WO", number: "2020123456", kind: "A1" }],
  ["WO2020123456", { type: DocType.Publication, country: "WO", number: "2020123456" }],
];

for (const [raw, expected] of publications) {
  check(raw, () => assertFields(raw, expected));
}

// --- parse: applications ---

console.log("parse applications");
const applications: Array<[string, ExpectedFields]> = [
  ["EP 02729749.3", { type: DocType.Application, country: "EP", number: "02729749", checkDigit: "3" }],
  ["EP02729749", { type: DocType.Application, country: "EP", number: "02729749" }],
  [
    "EP20020729749",
    { type: DocType.Application, country: "EP", number: "02729749", year: "2002" },
  ],
  ["US 16/123,456", { type: DocType.Application, country: "US", number: "123456", series: "16" }],
  [
    "PCT/US2020/012345",
    { type: DocType.Application, country: "WO", number: "012345", year: "2020", pctOffice: "US" },
  ],
];

for (const [raw, expected] of applications) {
  check(raw, () => assertFields(raw, expected));
}

// US series/serial vs grant with commas
check("US 16/123,456 is application (not publication)", () => {
  assert.equal(new DocNumber("US 16/123,456").type, DocType.Application);
});
check("US 11,234,567 is publication (not application)", () => {
  assert.equal(new DocNumber("US 11,234,567").type, DocType.Publication);
});

// EP year-form requires the 7-digit serial to start with 0 (YYYY + 0 + 6 digits).
check("EP20020729749 is year-form application", () => {
  const d = new DocNumber("EP20020729749");
  assert.equal(d.type, DocType.Application);
  assert.equal(d.year, "2002");
  assert.equal(d.number, "02729749");
});
check("EP20021234567 is not year-form (serial7 must start with 0)", () => {
  const d = new DocNumber("EP20021234567");
  assert.notEqual(d.type === DocType.Application && d.year === "2002", true);
});

// PCT vs WO publication
check("PCT/US2020/012345 is application; WO 2020/123456 is publication", () => {
  assert.equal(new DocNumber("PCT/US2020/012345").type, DocType.Application);
  assert.equal(new DocNumber("WO 2020/123456").type, DocType.Publication);
});

// --- unparseable ---

console.log("unparseable");
for (const bad of ["1234", "foo", "", "   "]) {
  check(`throws on ${JSON.stringify(bad)}`, () => {
    assert.throws(() => new DocNumber(bad), /Cannot parse document number/);
  });
}

// --- formatCandidates ---

console.log("formatCandidates");
check("kind present: docdb first, then epodoc", () => {
  assertCandidates(new DocNumber("EP.1393417.B1").formatCandidates(), [
    { number: "EP.1393417.B1", format: OpsFormat.Docdb },
    { number: "EP1393417B1", format: OpsFormat.Epodoc },
  ]);
});

check("kind absent: epodoc then A1/B1/A2/B2/A/B", () => {
  assertCandidates(new DocNumber("EP1393417").formatCandidates(), [
    { number: "EP1393417", format: OpsFormat.Epodoc },
    { number: "EP.1393417.A1", format: OpsFormat.Docdb },
    { number: "EP.1393417.B1", format: OpsFormat.Docdb },
    { number: "EP.1393417.A2", format: OpsFormat.Docdb },
    { number: "EP.1393417.B2", format: OpsFormat.Docdb },
    { number: "EP.1393417.A", format: OpsFormat.Docdb },
    { number: "EP.1393417.B", format: OpsFormat.Docdb },
  ]);
});

check("US slash form keeps padded zeros in candidates", () => {
  assertCandidates(new DocNumber("US 2024/0318857 A1").formatCandidates(), [
    { number: "US.20240318857.A1", format: OpsFormat.Docdb },
    { number: "US20240318857A1", format: OpsFormat.Epodoc },
  ]);
});

check("formatCandidates rejects application", () => {
  assert.throws(() => new DocNumber("EP02729749").formatCandidates(), /expects a publication/);
});

// --- epodoc / docdb ---

console.log("epodoc / docdb");
check("epodoc with kind", () => {
  assert.equal(new DocNumber("EP.1393417.B1").epodoc(), "EP1393417B1");
});
check("docdb with kind", () => {
  assert.equal(new DocNumber("EP.1393417.B1").docdb(), "EP.1393417.B1");
});
check("epodoc without kind", () => {
  assert.equal(new DocNumber("EP1393417").epodoc(), "EP1393417");
});
check("docdb without kind", () => {
  assert.equal(new DocNumber("EP1393417").docdb(), "EP.1393417");
});
check("US padded form", () => {
  const d = new DocNumber("US 2024/0318857 A1");
  assert.equal(d.epodoc(), "US20240318857A1");
  assert.equal(d.docdb(), "US.20240318857.A1");
});
check("epodoc rejects application", () => {
  assert.throws(() => new DocNumber("EP02729749").epodoc(), /expects a publication/);
});
check("docdb rejects application", () => {
  assert.throws(() => new DocNumber("EP02729749").docdb(), /expects a publication/);
});

// --- applicationCandidates ---

console.log("applicationCandidates");
check("EP year-prefixed form", () => {
  assertCandidates(new DocNumber("EP20020729749").applicationCandidates(), [
    { number: "EP20020729749", format: OpsFormat.Epodoc },
    { number: "EP.20020729749", format: OpsFormat.Docdb },
    { number: "EP02729749", format: OpsFormat.Epodoc },
    { number: "EP.02729749", format: OpsFormat.Docdb },
  ]);
});

check("EP short form with check digit", () => {
  assertCandidates(new DocNumber("EP 02729749.3").applicationCandidates(), [
    { number: "EP02729749", format: OpsFormat.Epodoc },
    { number: "EP02729749.3", format: OpsFormat.Epodoc },
    { number: "EP.02729749", format: OpsFormat.Docdb },
  ]);
});

check("PCT respells away from PCT/ path", () => {
  const cands = new DocNumber("PCT/US2020/012345").applicationCandidates();
  assertCandidates(cands, [
    { number: "WO2020US012345", format: OpsFormat.Epodoc },
    { number: "US2020012345", format: OpsFormat.Epodoc },
    { number: "WO.2020US012345", format: OpsFormat.Docdb },
  ]);
  for (const c of cands) {
    assert.ok(!c.number.includes("PCT/"), `must not contain PCT/: ${c.number}`);
  }
});

check("US series/serial", () => {
  assertCandidates(new DocNumber("US 16/123,456").applicationCandidates(), [
    { number: "US16123456", format: OpsFormat.Epodoc },
  ]);
});

check("applicationCandidates rejects publication", () => {
  assert.throws(() => new DocNumber("EP1393417").applicationCandidates(), /expects an application/);
});

// --- summary ---

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
