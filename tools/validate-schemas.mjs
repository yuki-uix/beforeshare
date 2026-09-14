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
import { computeStatus, reducesCoverage } from './status.mjs';
import { buildCapabilities, REGISTRY, ACTION_FACTS } from './capabilities.mjs';
import { isSuccessfulOutcome, summariseVerification, SUCCESSFUL_OUTCOMES, VERIFICATION_OUTCOMES } from './verification.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = join(root, 'schemas', 'v1');
const exampleDir = join(schemaDir, 'examples');

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

// allowUnionTypes is the one strict-mode relaxation: a preservation measurement
// is legitimately a number for a ratio and a string for an orientation, and
// collapsing both into `string` would lose the ability to compare against a
// numeric tolerance. Everything else stays strict.
const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
addFormats(ajv);

for (const file of readdirSync(schemaDir).filter((f) => f.endsWith('.schema.json'))) {
  ajv.addSchema(read(join(schemaDir, file)), file);
}

const validate = ajv.getSchema('inspection-result.schema.json');
const manifest = read(join(exampleDir, 'manifest.json')).examples;

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
const onDisk = readdirSync(exampleDir).filter((f) => f.endsWith('.json') && f !== 'manifest.json').sort();
if (onDisk.length === 0) fail('no examples found - the example set must not be empty');

const unregistered = onDisk.filter((f) => !manifest[f]);
const missingFiles = Object.keys(manifest).filter((f) => !onDisk.includes(f));
check('every example file is registered in the manifest', unregistered.length === 0, unregistered.join(', '));
check('every manifest entry has a file', missingFiles.length === 0, missingFiles.join(', '));

for (const file of onDisk) {
  const schemaName = manifest[file];
  if (!schemaName) continue;
  const v = ajv.getSchema(schemaName);
  if (!v) { fail(`example ${file}: no compiled schema named ${schemaName}`); continue; }
  const ok = v(read(join(exampleDir, file)));
  if (ok) console.log(`ok    example ${file} (${schemaName})`);
  else fail(`example ${file}`, v.errors);
}

/** Examples that are inspection results — the checks below only apply to those. */
const examples = onDisk.filter((f) => manifest[f] === 'inspection-result.schema.json');

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

// --- negative cases for the verification contract ----------------------------
const verifyValidate = ajv.getSchema('verification-result.schema.json');
const vBase = read(join(exampleDir, 'verification-verified.json'));
const vClone = (mutate) => { const c = structuredClone(vBase); mutate(c); return c; };

const verifyNegatives = [
  ['a successful outcome without an independent reader is rejected (§10.1)',
    vClone((r) => { r.results[0].readPaths = [{ reader: 'pdf.metadata', version: '1.0.0', role: 'shares_writer_implementation', surface: 'metadata_block' }]; })],

  ['a successful outcome cannot carry an unverifiableReason',
    vClone((r) => { r.results[0].unverifiableReason = 'reader_error'; })],

  ['a successful outcome must name the surfaces it checked',
    vClone((r) => { delete r.results[0].surfacesChecked; })],

  ['unable_to_verify without a reason is rejected',
    vClone((r) => { r.results[0].outcome = 'unable_to_verify'; delete r.results[0].surfacesChecked; })],

  ['an unknown verification outcome is rejected',
    vClone((r) => { r.results[0].outcome = 'probably_gone'; })],

  ['a measurement that ran must state its tolerance (§10.3)',
    vClone((r) => { delete r.preservation.renderComparison.tolerance; })],

  ['a measurement that did not run must say why',
    vClone((r) => { r.preservation.pageCount = { checked: false, outcome: 'not_checked' }; })],

  ['a not_checked measurement cannot claim an outcome',
    vClone((r) => { r.preservation.pageCount = { checked: false, outcome: 'preserved', notCheckedReason: 'x' }; })],

  ['a preservation key cannot be omitted',
    vClone((r) => { delete r.preservation.outputReadable; })],

  ['verification without any requested action is rejected',
    vClone((r) => { r.requested = []; })],

  ['a file reference without a hash is rejected (§14.1 stage binding)',
    vClone((r) => { delete r.sanitized.sha256; })],
];

for (const [name, doc] of verifyNegatives) {
  if (verifyValidate(doc)) fail(`negative case was ACCEPTED: ${name}`);
  else console.log(`ok    rejected: ${name}`);
}

// --- negative cases for the capability contract ------------------------------
const capValidate = ajv.getSchema('capabilities.schema.json');
const cBase = read(join(exampleDir, 'capabilities.json'));
const cClone = (mutate) => { const c = structuredClone(cBase); mutate(c); return c; };

const capNegatives = [
  ['not_established limits cannot carry a size (§13.1)',
    cClone((c) => { c.formats[0].testedLimits = { status: 'not_established', reason: 'x', maxTestedSizeBytes: 104857600 }; })],

  ['not_established limits must give a reason',
    cClone((c) => { c.formats[0].testedLimits = { status: 'not_established' }; })],

  ['measured limits must name a reference machine',
    cClone((c) => { c.formats[0].testedLimits = { status: 'measured', maxTestedSizeBytes: 1 }; })],

  ['measured limits cannot also carry a not-established reason',
    cClone((c) => { c.formats[0].testedLimits = { status: 'measured', maxTestedSizeBytes: 1, referenceMachine: 'm', measuredAt: '2026-01-01T00:00:00Z', reason: 'x' }; })],

  ['a format with no detectors is not expressible (§14.1)',
    cClone((c) => { c.formats[0].detectors = []; })],

  ['a generic supported flag is not expressible (§14.1)',
    cClone((c) => { c.formats[0].supported = true; })],

  ['a detector that emits nothing is rejected',
    cClone((c) => { c.formats[0].detectors[0].emits = []; })],

  ['an action without its verifiability declared is rejected',
    cClone((c) => { delete c.actions[0].verifiable; })],

  ['an unimplemented verifier cannot claim the surfaces it covers',
    cClone((c) => { c.actions[0].verifiable = { status: 'no_verifier_implemented', plannedSurfaces: ['raw_objects'], surfaces: ['raw_objects'] }; })],

  ['an available verifier must name its surfaces',
    cClone((c) => { c.actions[0].verifiable = { status: 'independent_reader_available' }; })],

  ['an available verifier cannot fall back to plannedSurfaces',
    cClone((c) => { c.actions[0].verifiable = { status: 'independent_reader_available', plannedSurfaces: ['raw_objects'] }; })],

  ['an unknown verifiability status is rejected',
    cClone((c) => { c.actions[0].verifiable = { status: 'probably_verifiable', surfaces: ['raw_objects'] }; })],

  ['an action without confirmationRequired is rejected',
    cClone((c) => { delete c.actions[0].confirmationRequired; })],

  ['an unknown media type is rejected',
    cClone((c) => { c.formats[0].mediaType = 'image/heic'; })],
];

for (const [name, doc] of capNegatives) {
  if (capValidate(doc)) fail(`negative case was ACCEPTED: ${name}`);
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
// NOTE: the comparison below is this checker's own copy of the ordering rule,
// because no core sorter exists yet. When E3/E4 produce one, this must call it
// instead — otherwise a drifting implementation gets validated against a stale
// duplicate of the rule it was supposed to be checked against.
// Array order is observable output and §17.5 requires it to be deterministic, so
// it is checked rather than merely documented. An unordered example teaches the
// wrong thing to anyone copying it.
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
// Recursive: JSON.stringify's array-replacer form filters keys at EVERY level, so
// passing the top-level key list silently flattens nested objects to {} and makes
// two locations differing only in, say, their rect compare equal.
const canonicalLocation = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonicalLocation).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalLocation(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};
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

// --- the declared status of every example must be the computed one -----------
// This is what keeps the decision table honest. A status written by hand into an
// example is an assertion nobody checks; run through the rules, each example
// becomes a test case for them, and a rule change that breaks an example shows up
// here instead of in a reviewer's memory.
for (const file of examples) {
  const doc = read(join(exampleDir, file));
  const computed = computeStatus(doc);
  check(`${file} declares the status the rules produce`, computed.status === doc.status,
    `declared ${doc.status}, rules give ${computed.status} (${computed.reason})`);
}

// --- every skip reason must be classified ------------------------------------
// Same shape as the category defaults check: adding a coverageSkipReason forces a
// decision about whether it reduces coverage, rather than letting it default to
// "harmless" and quietly widen what counts as a clean result.
const skipReasons = enums.$defs.coverageSkipReason.enum;
for (const reason of skipReasons) {
  let classified = true;
  try { reducesCoverage(reason); } catch { classified = false; }
  check(`skip reason ${reason} is classified in status-inputs.json`, classified);
}
const statusInputs = read(join(schemaDir, 'status-inputs.json'));
const orphanReasons = Object.keys(statusInputs.skipReasons).filter((r) => !skipReasons.includes(r));
check('no skip-reason classification without an enum value', orphanReasons.length === 0,
  `orphan: ${orphanReasons.join(', ')}`);
check('the blocking rule references declared enum values',
  enums.$defs.severity.enum.includes(statusInputs.blockingRule.severity)
  && enums.$defs.certainty.enum.includes(statusInputs.blockingRule.certainty),
  JSON.stringify(statusInputs.blockingRule));

// --- the capability declaration is generated, never hand-maintained ----------
// This is the check that gives §14.1's "declare exact capabilities" any force.
// Adding a detector to the registry changes the generated declaration; if the
// committed example is not regenerated, the build fails rather than publishing a
// capability list that no longer describes the build.
const committedCaps = read(join(exampleDir, 'capabilities.json'));
const generatedCaps = buildCapabilities({ core: committedCaps.versions.core, app: committedCaps.versions.app });
check('the committed capability declaration matches the one generated from the registry',
  JSON.stringify(generatedCaps) === JSON.stringify(committedCaps),
  'run: node -e "import(\'./tools/capabilities.mjs\').then(async m => (await import(\'node:fs\')).writeFileSync(\'schemas/v1/examples/capabilities.json\', JSON.stringify(m.buildCapabilities({app:\'0.1.0\'}),null,2)+\'\\n\'))"');

// --- no detector id may appear anywhere without being registered -------------
// Detector ids are written by hand into coverage arrays, findings and version
// lists. An unregistered id there is a typo that silently claims a check ran.
const registered = new Set(Object.keys(REGISTRY.detectors));
for (const file of examples) {
  const doc = read(join(exampleDir, file));
  const used = new Set([
    ...doc.coverage.completed,
    ...doc.coverage.skipped.map((s) => s.detector),
    ...doc.coverage.failed.map((f) => f.detector),
    ...(doc.findings ?? []).map((f) => f.detector.id),
    ...(doc.versions.detectors ?? []).map((d) => d.id),
    ...(doc.limitations ?? []).flatMap((l) => l.affectedDetectors),
  ]);
  const unknown = [...used].filter((id) => !registered.has(id));
  check(`${file} uses only registered detector ids`, unknown.length === 0, unknown.join(', '));
}

// --- every registered detector emits only declared categories ----------------
const allCategories = enums.$defs.category.enum;
for (const [id, d] of Object.entries(REGISTRY.detectors)) {
  const bad = d.emits.filter((c) => !allCategories.includes(c));
  check(`registry detector ${id} emits only declared categories`, bad.length === 0, bad.join(', '));
  check(`registry detector ${id} declares a known certainty`,
    enums.$defs.certainty.enum.includes(d.certainty));
}

// --- every category is emitted by some detector ------------------------------
// A category nothing can produce is a taxonomy entry with no path to the user.
const emitted = new Set(Object.values(REGISTRY.detectors).flatMap((d) => d.emits));
const orphanCategories = allCategories.filter((c) => !emitted.has(c));
check('every category has at least one detector that emits it', orphanCategories.length === 0,
  orphanCategories.join(', '));

// --- every action has per-action facts, and every fact has an action ---------
const actionEnum = enums.$defs.remediationAction.enum;
const factActions = Object.keys(ACTION_FACTS);
check('every remediation action has capability facts',
  actionEnum.every((a) => factActions.includes(a)),
  actionEnum.filter((a) => !factActions.includes(a)).join(', '));
check('no capability facts without a declared action',
  factActions.every((a) => actionEnum.includes(a)),
  factActions.filter((a) => !actionEnum.includes(a)).join(', '));

// --- verifiability is a state, not an optimistic boolean ---------------------
// An earlier draft declared every action independently verifiable while no
// verifier existed, which made the assertion vacuously true. The state now has
// to match reality: a build claiming a reader must name the surfaces it reads,
// and one without a reader may only describe what it would read.
for (const entry of committedCaps.actions) {
  const v = entry.verifiable;
  if (v.status === 'independent_reader_available') {
    check(`action ${entry.action} names the surfaces its verifier reads`,
      Array.isArray(v.surfaces) && v.surfaces.length > 0 && v.plannedSurfaces === undefined,
      JSON.stringify(v));
    // The claim has to point at something. Without this the status is a string
    // anyone can flip, which is how the first version of this guard passed while
    // no verifier existed.
    const registeredVerifiers = Object.keys(REGISTRY.verifiers ?? {});
    const missing = (v.readers ?? []).filter((r) => !registeredVerifiers.includes(r));
    check(`action ${entry.action} names only registered verifiers`, missing.length === 0,
      `not in detector-registry.json verifiers: ${missing.join(', ')}`);
  } else {
    check(`action ${entry.action} declares its missing verifier explicitly`,
      v.status === 'no_verifier_implemented'
      && Array.isArray(v.plannedSurfaces) && v.plannedSurfaces.length > 0
      && v.surfaces === undefined,
      JSON.stringify(v));
  }
}

// --- the verification success set is defined in code, not in prose -----------
// §10.2 names two successful outcomes and forbids collapsing unable_to_verify
// into success. Without an executable definition there is nothing to check that
// claim against.
check('exactly two outcomes are successful', SUCCESSFUL_OUTCOMES.length === 2);
check('unable_to_verify is not successful', isSuccessfulOutcome('unable_to_verify') === false);
check('still_present is not successful', isSuccessfulOutcome('still_present') === false);
check('failed is not successful', isSuccessfulOutcome('failed') === false);
check('the success set is a subset of the declared outcomes',
  SUCCESSFUL_OUTCOMES.every((o) => VERIFICATION_OUTCOMES.includes(o)));
check('the outcome list matches the schema enum',
  JSON.stringify(VERIFICATION_OUTCOMES)
    === JSON.stringify(read(join(schemaDir, 'verification-result.schema.json')).$defs.actionResult.properties.outcome.enum));

let outcomeThrew = false;
try { isSuccessfulOutcome('probably_gone'); } catch { outcomeThrew = true; }
check('an unknown outcome throws instead of defaulting to failure', outcomeThrew);

for (const [file, expected] of [['verification-verified.json', true], ['verification-unable.json', false]]) {
  const doc = read(join(exampleDir, file));
  const s = summariseVerification(doc);
  check(`${file} summarises as ${expected ? 'successful' : 'not successful'}`, s.successful === expected, s.reason);
}

// A run that verified one action and could not verify another is not a success.
const mixed = structuredClone(read(join(exampleDir, 'verification-verified.json')));
mixed.results[1].outcome = 'unable_to_verify';
mixed.results[1].unverifiableReason = 'reader_error';
delete mixed.results[1].surfacesChecked;
check('a partially verified run is not summarised as successful',
  summariseVerification(mixed).successful === false);

// Content that changed beyond tolerance fails the run whatever the removals did.
const damaged = structuredClone(read(join(exampleDir, 'verification-verified.json')));
damaged.preservation.pageCount.outcome = 'changed_beyond_tolerance';
check('content changed beyond tolerance fails the run',
  summariseVerification(damaged).successful === false);

// --- untested limits must say so, and must not carry numbers -----------------
for (const f of committedCaps.formats) {
  const t = f.testedLimits;
  if (t.status === 'not_established') {
    check(`${f.mediaType} declares its untested limits explicitly`,
      typeof t.reason === 'string' && t.reason.length > 0
      && t.maxTestedSizeBytes === undefined && t.maxTestedPageCount === undefined,
      JSON.stringify(t));
  } else {
    check(`${f.mediaType} measured limits name a reference machine`,
      typeof t.referenceMachine === 'string' && typeof t.maxTestedSizeBytes === 'number');
  }
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  ${examples.length} examples, ${negatives.length + verifyNegatives.length + capNegatives.length} negative cases, ${enumCats.length} categories, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
