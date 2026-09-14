#!/usr/bin/env node
/**
 * Compiles the v1 schemas and validates every committed example against them.
 *
 * This also runs a set of NEGATIVE cases. A validator that only ever sees valid
 * input proves nothing: if a constraint silently stopped being enforced, the
 * positive examples would still pass. Each negative case names the rule it is
 * pinning, and the run fails if a case that must be rejected is accepted.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = join(root, 'schemas', 'v1');
const exampleDir = join(schemaDir, 'examples');

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);

for (const file of readdirSync(schemaDir).filter((f) => f.endsWith('.schema.json'))) {
  ajv.addSchema(read(join(schemaDir, file)), file);
}

const validate = ajv.getSchema('inspection-result.schema.json');

let failures = 0;
const fail = (msg, errors) => {
  failures += 1;
  console.error(`FAIL  ${msg}`);
  if (errors) for (const e of errors) console.error(`        ${e.instancePath || '/'} ${e.message}`);
};

const check = (name, cond, detail) => {
  if (cond) console.log(`ok    ${name}`);
  else fail(name, detail ? [{ instancePath: '', message: detail }] : undefined);
};

// --- positive: every committed example must validate -------------------------
const examples = readdirSync(exampleDir).filter((f) => f.endsWith('.json')).sort();
if (examples.length === 0) fail('no examples found - the example set must not be empty');

for (const file of examples) {
  const ok = validate(read(join(exampleDir, file)));
  if (ok) console.log(`ok    example ${file}`);
  else fail(`example ${file}`, validate.errors);
}

// --- negative: each case pins one rule that must stay enforced ----------------
const base = read(join(exampleDir, 'review-required.json'));
const clone = (mutate) => {
  const copy = structuredClone(base);
  mutate(copy);
  return copy;
};

const negatives = [
  ['unknown status value is rejected (§20.3 unknown enum fails visibly)',
    clone((r) => { r.status = 'probably_fine'; })],

  ['unknown finding category is rejected',
    clone((r) => { r.findings[0].category = 'something_new'; })],

  ['missing coverage is rejected (§20.3 missing coverage fails visibly)',
    clone((r) => { delete r.coverage; })],

  ['a skipped detector without a reason is rejected (§17.1 accurate coverage)',
    clone((r) => { r.coverage.skipped.push({ detector: 'pdf.text_layer' }); })],

  ['an OCR finding without coordinates is rejected (§8.2)',
    clone((r) => { delete r.findings[2].location.rect; })],

  ['an OCR finding without confidence is rejected (§8.2)',
    clone((r) => { delete r.findings[2].location.confidence; })],

  ['evidence cannot carry an unmasked value field (§8.2)',
    clone((r) => { r.findings[0].evidence.fullValue = 'yuki@example.com'; })],

  ['displayValue longer than the cap is rejected',
    clone((r) => { r.findings[0].evidence.displayValue = 'x'.repeat(65); })],

  ['supported remediation must declare sideEffects (§9.2)',
    clone((r) => { delete r.findings[0].remediation.sideEffects; })],

  ['unsupported remediation must give a reason',
    clone((r) => { r.findings[1].remediation = { supported: false }; })],

  ['unsupported remediation must not also carry an action',
    clone((r) => { r.findings[1].remediation = { supported: false, unsupportedReason: 'not_implemented', action: 'remove_annotations' }; })],

  ['a limitation must name the detectors it affected (§5.8)',
    clone((r) => { r.limitations.push({ code: 'encrypted_content_not_inspected', impact: 'coverage_incomplete', affectedDetectors: [], message: 'x' }); })],

  ['a finding without a detector is rejected (§14.1 version visibility)',
    clone((r) => { delete r.findings[0].detector; })],

  ['a non-UTC timestamp is rejected',
    clone((r) => { r.startedAt = '2026-01-01T00:00:00+08:00'; })],

  ['an uppercase or truncated sha256 is rejected',
    clone((r) => { r.input.sha256 = 'ABC123'; })],

  ['unknown top-level properties are rejected',
    clone((r) => { r.safe = true; })],

  ['a location kind with the wrong payload is rejected',
    clone((r) => { r.findings[0].location = { kind: 'pdf_metadata', page: 3 }; })],

  ['a masking policy other than structural_label cannot claim redacted:false',
    clone((r) => { r.findings[1].evidence.redacted = false; })],

  ['structural_label cannot claim redacted:true',
    clone((r) => { r.findings[1].evidence = { displayValue: 'AES-256', redacted: true, maskPolicy: 'structural_label' }; })],

  ['a supported remediation cannot also carry an unsupportedReason',
    clone((r) => { r.findings[0].remediation.unsupportedReason = 'not_implemented'; })],

  ['an unsupported remediation cannot carry sideEffects',
    clone((r) => { r.findings[0].remediation = { supported: false, unsupportedReason: 'not_implemented', sideEffects: [] }; })],

  ['an unsupported remediation cannot carry an actionGroupId',
    clone((r) => { r.findings[0].remediation = { supported: false, unsupportedReason: 'not_implemented', actionGroupId: 'g1' }; })],

  ['an unsupported remediation cannot carry alternativeActions',
    clone((r) => { r.findings[0].remediation = { supported: false, unsupportedReason: 'not_implemented', alternativeActions: [{ action: 'remove_annotations', sideEffects: [] }] }; })],
];

for (const [name, doc] of negatives) {
  if (validate(doc)) fail(`negative case was ACCEPTED: ${name}`);
  else console.log(`ok    rejected: ${name}`);
}

// --- category defaults must stay in lockstep with the enum -------------------
// The enum is the source of truth for which categories exist. This check is what
// makes adding a category impossible without also deciding its default certainty
// and severity: a new enum value with no row here fails the build.
const enums = read(join(schemaDir, 'enums.schema.json'));
const defaults = read(join(schemaDir, 'category-defaults.json'));
const enumCats = enums.$defs.category.enum;
const tableCats = Object.keys(defaults.categories);

const missing = enumCats.filter((c) => !tableCats.includes(c));
const orphan = tableCats.filter((c) => !enumCats.includes(c));
check('every category has a defaults row', missing.length === 0, `missing: ${missing.join(', ')}`);
check('no defaults row without a category', orphan.length === 0, `orphan: ${orphan.join(', ')}`);

const groups = enums.$defs.categoryGroup.enum;
const severities = enums.$defs.severity.enum;
const certainties = enums.$defs.certainty.enum;
for (const [name, row] of Object.entries(defaults.categories)) {
  check(`defaults row ${name} uses declared enum values`,
    groups.includes(row.group) && severities.includes(row.defaultSeverity) && certainties.includes(row.defaultCertainty),
    JSON.stringify(row));
}

// --- examples must respect the defaults table --------------------------------
// A finding may only deviate from its default certainty where the table says the
// certainty legitimately varies. Without this, "probabilistic" becomes whatever
// a given detector felt like emitting.
for (const file of examples) {
  const doc = read(join(exampleDir, file));
  for (const f of doc.findings ?? []) {
    const row = defaults.categories[f.category];
    if (!row) { fail(`example ${file}: finding ${f.id} uses a category with no defaults row`); continue; }
    check(`${file}:${f.id} group matches the defaults table`, f.group === row.group,
      `finding says ${f.group}, table says ${row.group}`);
    if (f.certainty !== row.defaultCertainty) {
      check(`${file}:${f.id} may deviate from default certainty`, row.certaintyMayVary === true,
        `${f.category} defaults to ${row.defaultCertainty} and is not marked certaintyMayVary`);
    }
  }
}

// --- committed examples must obey the ordering contract ----------------------
// Array order is observable output and §17.5 requires it to be deterministic, so
// it is checked rather than merely documented. An unordered example teaches the
// wrong thing to anyone copying it.
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const canonicalLocation = (loc) => JSON.stringify(loc, Object.keys(loc).sort());
const sortKey = (f) => [SEVERITY_RANK[f.severity], f.category, canonicalLocation(f.location), f.id];
const lte = (a, b) => {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return true;
};

for (const file of examples) {
  const doc = read(join(exampleDir, file));
  const keys = (doc.findings ?? []).map(sortKey);
  let ordered = true;
  for (let i = 1; i < keys.length; i += 1) if (!lte(keys[i - 1], keys[i])) ordered = false;
  check(`${file} findings follow the documented ordering`, ordered,
    (doc.findings ?? []).map((f) => `${f.id}:${f.severity}`).join(' -> '));
}

// --- severity may be raised with a reason, never silently lowered ------------
for (const file of examples) {
  const doc = read(join(exampleDir, file));
  for (const f of doc.findings ?? []) {
    const row = defaults.categories[f.category];
    if (!row) continue;
    check(`${file}:${f.id} severity is not below the category default`,
      SEVERITY_RANK[f.severity] <= SEVERITY_RANK[row.defaultSeverity],
      `${f.category} is ${f.severity}, default is ${row.defaultSeverity}`);
  }
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  ${examples.length} examples, ${negatives.length} negative cases, ${enumCats.length} categories, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
