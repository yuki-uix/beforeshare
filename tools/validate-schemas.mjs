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
];

for (const [name, doc] of negatives) {
  if (validate(doc)) fail(`negative case was ACCEPTED: ${name}`);
  else console.log(`ok    rejected: ${name}`);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  ${examples.length} examples, ${negatives.length} negative cases, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
