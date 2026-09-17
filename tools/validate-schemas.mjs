#!/usr/bin/env node
/**
 * Compiles the v1 schemas and validates every committed example against them.
 *
 * This also runs a set of NEGATIVE cases. A validator that only ever sees valid
 * input proves nothing: if a constraint silently stopped being enforced, the
 * positive examples would still pass. Each negative case names the rule it is
 * pinning, and the run fails if a case that must be rejected is accepted.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { computeStatus, reducesCoverage } from './status.mjs';
import { buildCapabilities, REGISTRY, ACTION_FACTS, unsupportedMediaTypesInSources } from './capabilities.mjs';
import { isSuccessfulOutcome, summariseVerification, SUCCESSFUL_OUTCOMES, VERIFICATION_OUTCOMES } from './verification.mjs';
import { POLICIES } from './masking.mjs';
import { OUTPUT_REJECTIONS } from './output-naming.mjs';
import { FAILURE_CODES, INTERRUPTION_POINTS, CANCELLATION_CHECKPOINTS } from './failure-semantics.mjs';
import {
  THREATS, TEMP_REFUSALS, TEMP_MODE, readableByOthers,
} from './temp-files.mjs';
import { REGISTRY_REFUSALS, RECORD_FIELDS } from './run-registry.mjs';
import { LIMIT_REFUSALS, OUTCOMES, BASIS_KINDS, budgetsWithoutBasis } from './limits.mjs';
import {
  DETECTION_REFUSALS, ESCALATABLE, CONSIDERED_AND_NOT_RAISED,
} from './pdf-detection.mjs';
import { REJECTION_REASONS } from './path-gate.mjs';
import { IDENTITY_REJECTIONS, STAGES } from './file-identity.mjs';
import { SUPPORTED_MEDIA_TYPES } from './media-types.mjs';
import { BREAKING_KINDS, ADDITIVE_KINDS, CHANGE_TYPES } from './versioning.mjs';

// A suite that dies instead of failing reports nothing about the case it died
// on. Anything reading this output for failures — the CI guard among them —
// sees no FAIL line and concludes the guard stopped working, or worse, that
// nothing went wrong. Any escape becomes one FAIL line and a non-zero exit.
process.on('uncaughtException', (e) => {
  console.error(`FAIL  the suite aborted instead of reporting a failure\n        ${e?.stack ?? e}`);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error(`FAIL  the suite aborted on a rejected promise\n        ${e?.stack ?? e}`);
  process.exit(1);
});


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
const manifestRaw = read(join(exampleDir, 'manifest.json')).examples;
/** file -> schema name, for the many places that only need that. */
const manifest = Object.fromEntries(Object.entries(manifestRaw).map(([f, v]) => [f, v.schema]));

let failures = 0;
const fail = (msg, errors) => {
  failures += 1;
  console.error(`FAIL  ${msg}`);
  if (errors) for (const e of errors) console.error(`        ${e.instancePath || '/'} ${e.message}`);
};

/**
 * An assertion whose expression throws must fail, not kill the run.
 *
 * `check(name, subject())` evaluates its argument first, so a throwing subject
 * escapes before check runs: the process dies with a stack trace, no FAIL line
 * is printed, and the CI guard reading that output for failures sees none. A
 * run that dies instead of failing reports nothing about the case it died on.
 *
 * Passing a function defers the call to inside the try; plain values still work.
 */
const check = (name, cond, detail) => {
  let value;
  try {
    value = typeof cond === 'function' ? cond() : cond;
  } catch (e) {
    fail(name, [{ instancePath: '', message: `threw instead of returning: ${e?.message ?? e}` }]);
    return;
  }
  if (value) console.log(`ok    ${name}`);
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

  ['a result without parser versions is rejected (§14.1 version visibility)',
    clone((r) => { delete r.versions.parsers; })],

  ['an empty parser list is rejected',
    clone((r) => { r.versions.parsers = []; })],


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

  ['a reader that could not open the output cannot claim a surface',
    vClone((r) => {
      r.results[0] = { ...r.results[0], outcome: 'unable_to_verify', unverifiableReason: 'output_could_not_be_reopened',
        surfacesChecked: ['raw_objects'] };
    })],

  ['a run with no reader for the action cannot claim a read surface',
    vClone((r) => {
      r.results[0] = { ...r.results[0], outcome: 'unable_to_verify', unverifiableReason: 'no_independent_reader_for_this_action',
        surfacesChecked: [], readPaths: [{ reader: 'verify.object_scanner', version: '1.0.0', role: 'independent', surface: 'raw_objects' }] };
    })],

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

  ['a measurement that ran cannot report a null value',
    vClone((r) => { r.preservation.pageCount.measured = null; })],

  ['a preservation key cannot borrow another key\'s metric',
    vClone((r) => { r.preservation.pageCount.metric = 'readability'; })],
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

  ['a detector without an implementation status is rejected',
    cClone((c) => { delete c.formats[0].detectors[0].status; })],

  ['an unimplemented detector cannot name an adapter',
    cClone((c) => { c.formats[0].detectors[0] = { ...c.formats[0].detectors[0], status: 'not_implemented', adapter: 'x.mjs' }; })],

  ['an implemented detector must name an adapter',
    cClone((c) => { c.formats[0].detectors[0] = { ...c.formats[0].detectors[0], status: 'implemented', waitingOn: undefined, adapter: undefined }; })],

  ['a limitation cannot name a media type outside the supported set',
    cClone((c) => { c.limitations[0].mediaTypes = ['image/heic']; })],

  ['an implemented action cannot still be waiting on an issue',
    cClone((c) => { c.actions[0] = { ...c.actions[0], status: 'implemented', waitingOn: '#7' }; })],

  ['a format action must declare its status, not just its name',
    cClone((c) => { c.formats[0].actions[0] = 'remove_pdf_metadata_field'; })],

  ['an unimplemented format action must say what it waits on',
    cClone((c) => { c.formats[0].actions[0] = { action: 'remove_pdf_metadata_field', status: 'not_implemented' }; })],

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

// Driven by the manifest, not by a list written beside the loop. A third
// verification example added later would have gone unchecked by that list, with
// nothing to say so.
for (const [file, entry] of Object.entries(manifestRaw)) {
  if (entry.schema !== 'verification-result.schema.json') continue;
  check(`${file} declares whether it summarises as successful`,
    typeof entry.expectSuccessful === 'boolean',
    'add expectSuccessful to its manifest entry');
  if (typeof entry.expectSuccessful !== 'boolean') continue;
  const summary = summariseVerification(read(join(exampleDir, file)));
  check(`${file} summarises as ${entry.expectSuccessful ? 'successful' : 'not successful'}`,
    summary.successful === entry.expectSuccessful, summary.reason);
}

// Duplicate actions must not let one result answer two requests.
check('two requests answered by one result is not successful',
  summariseVerification({
    requested: [{ action: 'remove_pdf_metadata_field' }, { action: 'remove_pdf_metadata_field' }],
    results: [{ action: 'remove_pdf_metadata_field', outcome: 'verified_removed' }],
    preservation: {},
  }).successful === false);
check('results out of order with requested is not successful',
  summariseVerification({
    requested: [{ action: 'remove_annotations' }, { action: 'remove_pdf_metadata_field' }],
    results: [
      { action: 'remove_pdf_metadata_field', outcome: 'verified_removed' },
      { action: 'remove_annotations', outcome: 'verified_removed' },
    ],
    preservation: {},
  }).successful === false);
check('a surplus result entry is not successful',
  summariseVerification({
    requested: [{ action: 'remove_annotations' }],
    results: [
      { action: 'remove_annotations', outcome: 'verified_removed' },
      { action: 'remove_annotations', outcome: 'verified_removed' },
    ],
    preservation: {},
  }).successful === false);

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

// --- the surface vocabulary has exactly one definition -----------------------
// An earlier version of this check compared four inline copies for equality.
// That is the wrong shape: it accepts the duplication and then polices it. The
// enum now lives once in common.schema.json and everything $refs it, so
// divergence is structurally impossible. What remains is a check that nobody
// reintroduces a copy — the only failure mode left.
{
  const canonical = JSON.stringify([...read(join(schemaDir, 'common.schema.json')).$defs.surface.enum].sort());
  const inlineCopies = [];
  const walk = (node, path, file) => {
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}/${i}`, file));
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.enum) && JSON.stringify([...node.enum].sort()) === canonical) {
      if (file !== 'common.schema.json') inlineCopies.push(`${file}${path}`);
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${path}/${k}`, file);
  };
  for (const file of readdirSync(schemaDir).filter((f) => f.endsWith('.schema.json'))) {
    walk(read(join(schemaDir, file)), '', file);
  }
  check('the surface vocabulary is defined once and referenced everywhere else',
    inlineCopies.length === 0,
    `inline copies found at: ${inlineCopies.join(', ')}`);
}

// --- every example kind is covered by a checker that actually runs -----------
// The detector-id check originally iterated only inspection examples, because
// those were the only examples when it was written. Two verification examples
// were then added naming five unregistered verifier ids and nothing noticed: the
// guard had not grown to the new kind of file.
//
// The first attempt at fixing that was a map from schema name to a description
// string. It had no teeth — the value was never used, so any string passed, and
// it was an assertion over a constant written in the same commit. The map now
// holds the checkers themselves and dispatches through them, so a kind with no
// checker fails the build and a registered checker demonstrably runs.
const knownReaders = new Set([
  ...Object.keys(REGISTRY.verifiers ?? {}),
  ...Object.keys(REGISTRY.detectors),
]);
const registeredDetectors = new Set(Object.keys(REGISTRY.detectors));
const registeredParsers = new Set(Object.keys(REGISTRY.parsers ?? {}));

const ID_CHECKERS = {
  'inspection-result.schema.json': (file, doc) => {
    // A detector is in exactly one state. The three arrays are each uniqueItems,
    // which says nothing about overlap between them - a detector could be
    // reported as having completed AND been skipped, and every consumer would
    // have to pick one to believe.
    //
    // Checked here rather than as a schema negative case: JSON Schema cannot
    // express an intersection across sibling arrays, so the negative-case
    // harness, which runs documents through ajv, is the wrong place to pin it.
    // The CI guard job covers it instead.
    const states = { completed: doc.coverage.completed, skipped: doc.coverage.skipped.map((x) => x.detector), failed: doc.coverage.failed.map((x) => x.detector) };
    const seen = new Map();
    const overlaps = [];
    for (const [state, ids] of Object.entries(states)) {
      for (const id of ids) {
        if (seen.has(id)) overlaps.push(`${id} in both ${seen.get(id)} and ${state}`);
        else seen.set(id, state);
      }
    }
    check(`${file} reports each detector in exactly one coverage state`, overlaps.length === 0,
      overlaps.join('; '));

    const used = new Set([
      ...doc.coverage.completed,
      ...doc.coverage.skipped.map((x) => x.detector),
      ...doc.coverage.failed.map((x) => x.detector),
      ...(doc.findings ?? []).map((f) => f.detector.id),
      ...(doc.versions.detectors ?? []).map((d) => d.id),
      ...(doc.limitations ?? []).flatMap((l) => l.affectedDetectors),
    ]);
    const unknown = [...used].filter((id) => !registeredDetectors.has(id));
    check(`${file} uses only registered detector ids`, unknown.length === 0, unknown.join(', '));

    // Parsers get the same treatment: §14.1 names them alongside detectors, so a
    // result citing a parser nobody registered is the same unverifiable claim.
    const parsers = (doc.versions.parsers ?? []).map((p) => p.id);
    const unknownParsers = parsers.filter((id) => !registeredParsers.has(id));
    check(`${file} uses only registered parser ids`, unknownParsers.length === 0, unknownParsers.join(', '));

    // Parsers are a subset of what applies, not the whole set. Detectors have
    // completed/skipped/failed, so demanding every applicable one be accounted
    // for is answerable; parsers have one list, so demanding every applicable one
    // be named would make a result claim it used a component it never invoked -
    // a PDF whose OCR was skipped never touched the renderer. This rule was
    // copied from the detector check without that difference surviving the copy.
    const mediaType = doc.input.mediaType;
    const applicableParsers = Object.entries(REGISTRY.parsers ?? {})
      .filter(([, p]) => p.mediaTypes.includes(mediaType))
      .map(([id]) => id);
    const inapplicable = parsers.filter((id) => registeredParsers.has(id) && !applicableParsers.includes(id));
    check(`${file} names no parser that does not apply to ${mediaType}`, inapplicable.length === 0,
      inapplicable.join(', '));
  },

  'verification-result.schema.json': (file, doc) => {
    // A reader is either a registered verifier (independent) or a registered
    // detector (the writer-side path, which a result may record as long as it
    // is labelled as such).
    const used = new Set([
      ...doc.results.flatMap((r) => r.readPaths.map((p) => p.reader)),
      ...doc.versions.verifiers.map((v) => v.id),
    ]);
    const unknown = [...used].filter((id) => !knownReaders.has(id));
    check(`${file} names only registered readers`, unknown.length === 0, unknown.join(', '));

    // §10.1: surfacesChecked is what stops a partial check reading as a
    // complete one. Claiming a surface no read path touched defeats the field.
    for (const r of doc.results) {
      const examined = new Set(r.readPaths.map((p) => p.surface).filter(Boolean));
      const unread = (r.surfacesChecked ?? []).filter((sfc) => !examined.has(sfc));
      check(`${file}:${r.action} checked only surfaces some read path examined`,
        unread.length === 0, `claimed without a reader: ${unread.join(', ')}`);
    }
  },

  'capabilities.schema.json': (file, doc) => {
    const bad = doc.versions.detectors.filter((d) => !registeredDetectors.has(d.id));
    check(`${file} versions name only registered detectors`, bad.length === 0,
      bad.map((d) => d.id).join(', '));
    for (const f of doc.formats) {
      const unknown = f.detectors.filter((d) => !registeredDetectors.has(d.id));
      check(`${file} ${f.mediaType} names only registered detectors`, unknown.length === 0,
        unknown.map((d) => d.id).join(', '));
    }
  },
};

let dispatched = 0;
for (const [file, schemaName] of Object.entries(manifest)) {
  const checker = ID_CHECKERS[schemaName];
  check(`example kind ${schemaName} has an id checker`, checker !== undefined,
    `add one to ID_CHECKERS; ${file} is otherwise unchecked`);
  if (!checker) continue;
  checker(file, read(join(exampleDir, file)));
  dispatched += 1;
}
check('every example was dispatched to a checker', dispatched === Object.keys(manifest).length,
  `${dispatched} of ${Object.keys(manifest).length}`);

// --- an available verifier must be one that exists ---------------------------
const implementedVerifiers = Object.entries(REGISTRY.verifiers ?? {})
  .filter(([, v]) => v.status === 'implemented')
  .map(([id]) => id);
for (const entry of committedCaps.actions) {
  if (entry.verifiable.status !== 'independent_reader_available') continue;
  const missing = (entry.verifiable.readers ?? []).filter((r) => !implementedVerifiers.includes(r));
  check(`action ${entry.action} names only implemented verifiers`, missing.length === 0,
    `registered but not implemented, or absent: ${missing.join(', ')}`);
}

// --- nothing may be published as a capability it does not have ---------------
// Both directions, and both have been wrong here. A detector with no status at
// all was published as working, which is how a consumer would have concluded
// this build inspected PDFs before it did; and the seven that do work stayed
// declared not_implemented for two PRs after they shipped, which published a
// build less capable than the one running. An implemented entry names its
// adapter, so the status cannot be advanced by editing a string.
for (const f of committedCaps.formats) {
  for (const d of f.detectors) {
    check(`${f.mediaType} detector ${d.id} declares its implementation state`,
      d.status === 'not_implemented' ? typeof d.waitingOn === 'string' && d.adapter === undefined
        : typeof d.adapter === 'string',
      JSON.stringify({ status: d.status, adapter: d.adapter, waitingOn: d.waitingOn }));
  }
}

// --- media types in the sources must be inside the closed set ---------------
check('no detector or action declares a media type outside the supported set',
  unsupportedMediaTypesInSources().length === 0,
  unsupportedMediaTypesInSources().join('; '));

// --- every exported list is either derived from a schema or justified --------
// Several lists in tools/ restate a schema enum. They agreed by hand, and a
// value added to the schema and missed in the list produced no failure — a
// masking policy the schema accepts and the implementation throws on, a status
// the rules can emit that the reachability check never looks for.
//
// The table below is not the guard. The guard is the assertion under it: every
// exported array constant in tools/ must appear here, so adding one without
// deciding whether it mirrors a schema fails the build. That is the part that
// does not depend on anyone remembering.
const enumAt = (file, path) => path.split('.').reduce((n, k) => n[k], read(join(schemaDir, file)));


const MIRRORS = {
  POLICIES: { value: POLICIES, schema: ['evidence.schema.json', 'properties.maskPolicy.enum'] },
  IDENTITY_REJECTIONS: {
    value: IDENTITY_REJECTIONS,
    standalone: 'the binding\'s own vocabulary; identity-rules.json is data, and the validator compares the two directly',
  },
  STAGES: {
    value: STAGES,
    standalone: 'the three stages §14.1 names; they are not an enum in any schema',
  },
  DETECTION_REFUSALS: {
    value: DETECTION_REFUSALS,
    standalone: 'what the §7.1 mapping refuses; pdf-detection-rules.json is data, and the validator checks the two against each other directly',
  },
  ESCALATABLE: {
    value: ESCALATABLE,
    standalone: 'categories a detector may raise above E1\'s default; not an enum in any schema',
  },
  CONSIDERED_AND_NOT_RAISED: {
    value: CONSIDERED_AND_NOT_RAISED,
    standalone: 'categories this epic considered raising and did not; recorded so an absence does not read as an oversight',
  },
  LIMIT_REFUSALS: {
    value: LIMIT_REFUSALS,
    standalone: 'what the limit rules refuse; limit-rules.json is data, and the validator checks the two against each other directly',
  },
  OUTCOMES: {
    value: OUTCOMES,
    standalone: 'the three names an overrun can take, drawn from two existing enums and mapped here',
  },
  BASIS_KINDS: {
    value: BASIS_KINDS,
    standalone: 'how a budget default may be accounted for; not an enum in any schema',
  },
  REGISTRY_REFUSALS: {
    value: REGISTRY_REFUSALS,
    standalone: 'the run registry\'s own vocabulary; concurrency-rules.json is data, and the validator checks the two against each other directly',
  },
  RECORD_FIELDS: {
    value: RECORD_FIELDS,
    standalone: 'what a run record stores; not an enum in any schema',
  },
  TEMP_REFUSALS: {
    value: TEMP_REFUSALS,
    standalone: 'what the temporary-file rules refuse; temp-rules.json is data, and the validator checks the two against each other directly',
  },
  THREATS: {
    value: THREATS,
    standalone: 'the temporary file\'s threat entries; temp-rules.json is data, and the validator checks the two against each other directly',
  },
  FAILURE_CODES: {
    value: FAILURE_CODES,
    standalone: 'the failure table\'s own vocabulary; failure-rules.json is data, and the validator checks the two against each other directly',
  },
  INTERRUPTION_POINTS: {
    value: INTERRUPTION_POINTS,
    standalone: 'where the process can die during a publish; not an enum in any schema',
  },
  CANCELLATION_CHECKPOINTS: {
    value: CANCELLATION_CHECKPOINTS,
    standalone: 'where the run asks whether to stop; checked against the module\'s stop() calls directly',
  },
  OUTPUT_REJECTIONS: {
    value: OUTPUT_REJECTIONS,
    standalone: 'the output rules\' own vocabulary; output-rules.json is data, and the validator checks the two against each other directly',
  },
  REJECTION_REASONS: {
    value: REJECTION_REASONS,
    standalone: 'the gate\'s own vocabulary; path-rules.json is data, and the validator checks the two against each other directly',
  },
  SUPPORTED_MEDIA_TYPES: {
    value: SUPPORTED_MEDIA_TYPES,
    schema: ['common.schema.json', '$defs.mediaType.enum'],
  },
  VERIFICATION_OUTCOMES: {
    value: VERIFICATION_OUTCOMES,
    schema: ['verification-result.schema.json', '$defs.actionResult.properties.outcome.enum'],
  },
  // Verified mechanically, not asserted: none of the three equals any enum in the
  // schemas, which is what the standalone check below confirms. They classify
  // changes to the contract rather than describing a value inside one.
  BREAKING_KINDS: { value: BREAKING_KINDS, standalone: 'classifies a kind of schema change; no value in any document carries it' },
  ADDITIVE_KINDS: { value: ADDITIVE_KINDS, standalone: 'as BREAKING_KINDS' },
  CHANGE_TYPES: { value: CHANGE_TYPES, standalone: 'the changelog vocabulary; CHANGELOG.json is data, not a schema, so there is no enum to mirror' },

  SUCCESSFUL_OUTCOMES: {
    value: SUCCESSFUL_OUTCOMES,
    // Registered as a mirror, not standalone. It is a subset of the outcome enum,
    // but it is also exactly the condition the schema uses to decide which
    // outcomes must carry an independent reader — so the two have to agree, and
    // the standalone check caught the mislabel.
    schema: ['verification-result.schema.json', '$defs.actionResult.allOf.0.if.properties.outcome.enum'],
  },
};

// Every enum defined anywhere in the schemas, so a list claiming to have no
// counterpart can be checked against that claim rather than trusted.
const allSchemaEnums = [];
{
  const collect = (node, path, file) => {
    if (Array.isArray(node)) return node.forEach((v, i) => collect(v, `${path}/${i}`, file));
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.enum)) allSchemaEnums.push({ file, path, key: JSON.stringify([...node.enum].sort()) });
    for (const [k, v] of Object.entries(node)) collect(v, `${path}/${k}`, file);
  };
  for (const f of readdirSync(schemaDir).filter((x) => x.endsWith('.schema.json'))) {
    collect(read(join(schemaDir, f)), '', f);
  }
}

for (const [name, spec] of Object.entries(MIRRORS)) {
  if (spec.standalone) {
    check(`${name} is justified as standalone`, typeof spec.standalone === 'string' && spec.standalone.length > 0);
    // A free-text reason is not evidence. If the values happen to equal a schema
    // enum, the list is a mirror that was labelled standalone - which is how the
    // previous version of this guard could be defeated by editing one word.
    const key = JSON.stringify([...spec.value].sort());
    const match = allSchemaEnums.find((e) => e.key === key);
    check(`${name} really has no schema counterpart`, match === undefined,
      match ? `identical to ${match.file}${match.path}; register it as a mirror instead` : '');
    continue;
  }
  const [file, path] = spec.schema;
  check(`${name} matches ${file} ${path}`,
    JSON.stringify([...spec.value].sort()) === JSON.stringify([...enumAt(file, path)].sort()),
    `list ${JSON.stringify(spec.value)} vs schema ${JSON.stringify(enumAt(file, path))}`);
}

{
  // An exported array that nobody registered is a list whose relationship to the
  // schemas was never decided.
  //
  // Discovered by importing each module and inspecting what it exports, not by
  // matching source text. The first version used a regex anchored on
  // `export const NAME = [`, which missed a lowercase name, a declaration whose
  // bracket was on the next line, and Object.freeze - three ordinary spellings,
  // each of which would have let an unregistered list through. A guard whose
  // reach depends on how the code was typed is the same problem it exists to
  // solve.
  // --- every category's evidence is shown under a policy somebody chose -------
  //
  // The policy was picked per finding by hand: the examples named one and
  // nothing checked the rest, so a category could be shown unredacted because
  // nobody had decided about it. The table makes adding a category force the
  // decision, and this makes the table force it back.
  {
    const policyTable = read(join(schemaDir, 'evidence-policy.json'));
    const chosen = Object.fromEntries(
      Object.entries(policyTable.categories).filter(([k]) => !k.startsWith('$')));
    const categories = Object.keys(read(join(schemaDir, 'category-defaults.json')).categories);
    const known = read(join(schemaDir, 'evidence.schema.json')).properties.maskPolicy.enum;

    const undecided = categories.filter((c) => !(c in chosen));
    check('every category has an evidence policy', undecided.length === 0, undecided.join(', '));

    const orphans = Object.keys(chosen).filter((c) => !categories.includes(c));
    check('every evidence policy names a category that exists', orphans.length === 0,
      orphans.join(', '));

    const unknown = Object.entries(chosen).filter(([, p]) => !known.includes(p));
    check('every evidence policy is one the evidence schema allows', unknown.length === 0,
      unknown.map(([c, p]) => `${c}=${p}`).join(', '));

    // `structural_label` is the only policy that shows a value unredacted, so
    // choosing it is a claim that the value carries nothing about a person.
    // The claim is cheap to make silently and expensive to be wrong about, so
    // each one is named here rather than counted.
    const unredacted = Object.entries(chosen)
      .filter(([, p]) => p === 'structural_label')
      .map(([c]) => c);
    const personal = unredacted.filter((c) => c.startsWith('pii_'));
    check('no personal-information category is shown unredacted', personal.length === 0,
      personal.join(', '));
    check('the unredacted categories are the ones recorded here',
      JSON.stringify(unredacted.sort()) === JSON.stringify([
        'digital_signature', 'document_producer', 'document_timestamp', 'encryption_state',
        'image_capture_timestamp', 'image_device_make', 'image_device_model',
        'image_modification_timestamp', 'incremental_update', 'permission_state',
      ]),
      unredacted.join(', '));

    // Two different things were being spelled the same way. A value the
    // detector wrote - "this document declares an /Encrypt dictionary" - has
    // nothing in it to hide. A value copied out of the document does, and
    // showing it in full is a decision somebody has to make on purpose. The
    // core refuses the second under this policy unless the category is listed
    // here, and this checks the list is what it claims to be: the categories
    // named must carry the unredacted policy, and each must say why.
    const shownInFull = policyTable.shownInFull ?? [];
    const notUnredacted = shownInFull.filter((c) => chosen[c] !== 'structural_label');
    check('every category shown in full carries the unredacted policy',
      notUnredacted.length === 0, notUnredacted.join(', '));
    const unexplained = shownInFull.filter((c) => !(c in policyTable.reasons));
    check('every category shown in full says why', unexplained.length === 0,
      unexplained.join(', '));
    const shownPersonal = shownInFull.filter((c) => c.startsWith('pii_'));
    check('no personal-information category is shown in full', shownPersonal.length === 0,
      shownPersonal.join(', '));

    // A reason is not required for every row - most are obvious - but a reason
    // for a row that is gone is a rule nobody notices has stopped applying.
    const reasons = Object.keys(policyTable.reasons).filter((k) => !k.startsWith('$'));
    const strayReasons = reasons.filter((c) => !(c in chosen));
    check('every reason explains a category that still has a policy',
      strayReasons.length === 0, strayReasons.join(', '));
  }

  const toolsDir = join(schemaDir, '..', '..', 'tools');

  // Before importing anything. A suite that runs on import would end this
  // process during the loop below, which is how the original defect hid: the
  // check for it never ran, because the thing it checks killed the checker
  // first.
  //
  // Importing them is only safe while none of them *runs* on import. One did:
  // a new suite without the guard every other one carries executed inside this
  // validator and ended with process.exit(0), which replaced this process's
  // exit code. Sixteen guards in the same CI run reported that they no longer
  // checked anything, while the validator printed its own failures and exited 0.
  //
  // Checked by importing each one in a child process that then exits with a
  // number of its own choosing. If the child exits with that number, the import
  // returned; anything else means the module took the process with it. The
  // first version of this check read the source for an `isMain` line instead,
  // which is a guard whose reach depends on how the code was typed - the exact
  // problem the paragraph above this one exists to avoid.
  const SURVIVED = 77;
  const runsOnImport = [];
  for (const file of readdirSync(toolsDir).filter((f) => f.startsWith('test-') && f.endsWith('.mjs'))) {
    const href = pathToFileURL(join(toolsDir, file)).href;
    const probe = `import(${JSON.stringify(href)}).then(() => process.exit(${SURVIVED}), () => process.exit(${SURVIVED}));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      encoding: 'utf8',
      timeout: 60000,
    });
    if (result.status !== SURVIVED) {
      runsOnImport.push(`${file} (exited ${result.status ?? result.signal})`);
    }
  }
  check('no suite in tools/ ends the process that imports it',
    runsOnImport.length === 0,
    `${runsOnImport.join(', ')} - this validator imports them all, and one that exits on import replaces this exit code`);

  const found = [];
  if (runsOnImport.length > 0) {
    // Reporting the problem is not enough: importing the module anyway would
    // end this process with its exit code, and the failure above would be
    // printed by a process that exits 0. The rest of this section needs the
    // imports, so it is owed rather than faked.
    check('exported arrays were found to check', false,
      'not attempted: a suite would end this process on import');
  } else {
    for (const file of readdirSync(toolsDir).filter((f) => f.endsWith('.mjs'))) {
      const href = pathToFileURL(join(toolsDir, file)).href;
      // Importing the module currently being evaluated deadlocks on its own
      // top-level await. It exports nothing, so there is nothing to miss.
      if (href === import.meta.url) continue;
      const mod = await import(href);
      for (const [name, value] of Object.entries(mod)) {
        if (Array.isArray(value)) found.push({ file, name, value });
      }
    }
    check('exported arrays were found to check', found.length > 0);
  }


  // Matched by name AND value. Keying on the name alone let a second module
  // export something called SUPPORTED_MEDIA_TYPES holding entirely different
  // values and be treated as registered, with its contents never compared to
  // anything - a green light for a list nobody checked.
  const unregistered = found.filter((e) => !(e.name in MIRRORS));
  check('every exported array is registered in MIRRORS', unregistered.length === 0,
    unregistered.map((e) => `${e.file}:${e.name}`).join(', '));

  const impostors = found.filter((e) => {
    const spec = MIRRORS[e.name];
    return spec !== undefined && JSON.stringify(spec.value) !== JSON.stringify(e.value);
  });
  check('no exported array shares a registered name while holding different values',
    impostors.length === 0,
    impostors.map((e) => `${e.file}:${e.name} = ${JSON.stringify(e.value)}`).join('; '));
}

// --- coverage must account for every applicable detector ---------------------
// §17.1 requires coverage to be reported accurately. A detector that applies to
// this media type and appears in none of the three arrays is a check nobody can
// tell ran or not — which reads, to anyone consuming the result, as though it ran.
for (const file of examples) {
  const doc = read(join(exampleDir, file));
  const mediaType = doc.input.mediaType;
  const applicable = Object.entries(REGISTRY.detectors)
    .filter(([, d]) => d.mediaTypes.includes(mediaType))
    .map(([id]) => id);
  const accounted = new Set([
    ...doc.coverage.completed,
    ...doc.coverage.skipped.map((s) => s.detector),
    ...doc.coverage.failed.map((f) => f.detector),
  ]);
  const unaccounted = applicable.filter((id) => !accounted.has(id));
  check(`${file} accounts for every detector applicable to ${mediaType}`,
    unaccounted.length === 0, `unaccounted: ${unaccounted.join(', ')}`);

  const inapplicable = [...accounted].filter((id) => !applicable.includes(id));
  check(`${file} reports no detector that does not apply to ${mediaType}`,
    inapplicable.length === 0, `inapplicable: ${inapplicable.join(', ')}`);
}

// --- every suppressed check must be explained --------------------------------
// A limitation names the detectors it affected; that is what stops a suppressed
// check from going unmentioned (§5.8). Benign skips are exempt: requiring a
// limitation for "this PNG has no EXIF block" would bury the real ones in noise.
for (const file of examples) {
  const doc = read(join(exampleDir, file));
  const needsExplaining = [
    ...doc.coverage.skipped.filter((s) => reducesCoverage(s.reason)).map((s) => s.detector),
    ...doc.coverage.failed.map((f) => f.detector),
  ];
  const explained = new Set((doc.limitations ?? []).flatMap((l) => l.affectedDetectors));
  const unexplained = needsExplaining.filter((d) => !explained.has(d));
  check(`${file} explains every check that did not run`, unexplained.length === 0,
    `no limitation names: ${unexplained.join(', ')}`);

  // Only coverage_incomplete limitations are claims that something did not run.
  // evidence_degraded and the rest legitimately describe a detector that did run
  // — a media-type mismatch degrades what the metadata reader's output means
  // without stopping it — so they are not held to this rule.
  const claimsNotRun = new Set(
    (doc.limitations ?? [])
      .filter((l) => l.impact === 'coverage_incomplete')
      .flatMap((l) => l.affectedDetectors),
  );
  const ranAnyway = [...claimsNotRun].filter((d) => doc.coverage.completed.includes(d));
  check(`${file} claims no completed check was skipped`, ranAnyway.length === 0,
    `coverage_incomplete limitation names detectors that completed: ${ranAnyway.join(', ')}`);
}

// --- every contract document ends with a handoff table -----------------------
// The repository's own review configuration requires one, and two documents had
// drifted to different headings instead - a rule stated in configuration and
// enforced nowhere. What a document does NOT decide is the part a reader needs
// most, and the part most easily lost when the document grows.
{
  // All of docs/, not docs/contracts/. The comment below worried about a
  // document in a subdirectory and stopped one level short: the first ADR
  // went into docs/adr/ and skipped the rule entirely, carrying a handoff
  // row that named a closed issue with nothing able to see it.
  //
  // The case study is the exception, and the only one: it records what is
  // required rather than what was decided, so it owes no account of what
  // it left open.
  const docsDir = join(schemaDir, '..', '..', 'docs');
  const NOT_A_DECISION_RECORD = ['product-case-study.md'];
  // Recursive: readdirSync sees direct children only, so a document in a
  // subdirectory would have skipped the handoff rule entirely while the check
  // reported itself as covering the contract documents.
  const collectDocs = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? collectDocs(join(dir, e.name), `${prefix}${e.name}/`)
      : e.name.endsWith('.md') ? [`${prefix}${e.name}`] : []);
  const allDocs = collectDocs(docsDir);
  const docs = allDocs.filter((f) => !NOT_A_DECISION_RECORD.includes(f));
  // An exception naming a file that is not there excludes nothing while
  // reading like an exemption someone considered.
  check('the exception names a document that is there',
    NOT_A_DECISION_RECORD.every((f) => allDocs.includes(f)),
    NOT_A_DECISION_RECORD.join(', '));
  check('documents outside docs/contracts are checked too',
    docs.some((f) => !f.startsWith('contracts/')), docs.join(', '));
  check('contract documents were found to check', docs.length > 0);
  for (const file of docs) {
    const text = readFileSync(join(docsDir, file), 'utf8');
    const hasHeading = text.includes('## Not decided here');
    check(`${file} has a handoff section`, hasHeading,
      'every contract document must end with "## Not decided here"');
    if (!hasHeading) continue;
    const section = text.slice(text.indexOf('## Not decided here'));
    // Per row, not per table. Requiring only that an Owner column exists let a
    // row with an empty owner cell pass - a question listed as open with nobody
    // holding it, which is the state the table is meant to make impossible.
    const rows = section.split('\n')
      .filter((l) => l.trim().startsWith('|') && !/^\|[\s:|-]+\|$/.test(l.trim()))
      .slice(1); // drop the header row
    check(`${file} handoff lists at least one question`, rows.length > 0,
      'the section must name what is open, not just exist');
    const ownerless = rows.filter((l) => {
      const cells = l.split('|').map((c) => c.trim()).filter((c, i, a) => i > 0 && i < a.length - 1);
      const owner = cells[cells.length - 1] ?? '';
      return !/#\d+|E\d+/.test(owner);
    });
    // An owner with no reason is the shape of a question parked on whichever
    // issue happened to be open. Ten rows here named the same issue because it
    // was the last one in its epic, not because it owned any of them - and one
    // of those rows was a bare issue number with nothing after it. The reason
    // is what makes the choice arguable, so it is required.
    const unreasoned = rows.filter((l) => {
      const cells = l.split('|').map((c) => c.trim()).filter((c, i, a) => i > 0 && i < a.length - 1);
      const owner = cells[cells.length - 1] ?? '';
      if (!/#\d+|E\d+/.test(owner)) return false;   // ownerless is reported separately
      return !/[-—]\s*\S/.test(owner);
    });
    check(`${file} every handoff row says why that owner`, unreasoned.length === 0,
      unreasoned.map((l) => l.trim().slice(0, 70)).join(' / '));
    check(`${file} every handoff row names an owner`, ownerless.length === 0,
      ownerless.map((l) => l.trim().slice(0, 60)).join(' / '));
  }
}

// --- rule tables: checked against the source, not against themselves --------
//
// Both rule modules build their exported reason list with Object.keys over the
// same JSON the table comes from, so comparing the two compares a file with
// itself: it passes for a reason nothing throws, and for one spelled wrong in
// both places at once. The independent fact is which literals the code actually
// hands to its rejection constructor, so read those out of the source.
const RULE_MODULE_DIR = join(schemaDir, '..', '..', 'tools');
function reasonsThrownIn(moduleFile, constructorName, extraProducers = []) {
  const src = readFileSync(join(RULE_MODULE_DIR, moduleFile), 'utf8');
  const thrown = new Set();
  // Not every name reaches the caller by being thrown: a failure code can be
  // decided by a classifier and returned. The producing forms are declared per
  // table, so the scan still looks at where names are made rather than at
  // whether the string appears anywhere in the file.
  const patterns = [`new ${constructorName}\\(\\s*['\"]([a-z_]+)['\"]`, ...extraProducers];
  for (const pattern of patterns) {
    for (const m of src.matchAll(new RegExp(pattern, 'g'))) thrown.add(m[1]);
  }
  return thrown;
}

/**
 * Every key at every level, checked against a declared shape.
 *
 * A node whose shape is not declared is reported rather than skipped: adding a
 * nested object to a rule table must force a decision about what may live in
 * it, the same way adding an enum value forces a row in the drift tables.
 */
function undeclaredKeys(node, shape, where) {
  if (shape === undefined) return [`${where}: nothing declares what may appear here`];
  const found = [];
  for (const [k, v] of Object.entries(node)) {
    const allowed = shape['*'] ?? shape[k];
    if (allowed === undefined) { found.push(`${where}.${k}`); continue; }
    const isNode = v && typeof v === 'object' && !Array.isArray(v);
    // true declares a leaf. An object arriving under one would carry keys the
    // walk never reaches, so the shape has to be widened deliberately rather
    // than outgrown silently.
    if (isNode && allowed === true) { found.push(`${where}.${k}: an object where a leaf was declared`); }
    else if (isNode) { found.push(...undeclaredKeys(v, allowed, `${where}.${k}`)); }
  }
  return found;
}

/**
 * Source with comments removed, so prose cannot satisfy a coverage check.
 *
 * Stripping whole comment lines is not enough: `const x = 0; // someRule` left
 * the name in the source and a rule nothing implements read as implemented. And
 * a blunt strip of everything after `//` would eat the contents of strings -
 * a URL alone would truncate the line - so the scan tracks which literal it is
 * inside. It is not a JavaScript parser and does not need to be; it needs to
 * know whether a `//` starts a comment.
 */
function withoutComments(source) {
  let out = '';
  let state = 'code';   // code | line | block | single | double | template | regex
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];
    const prevCode = out.trimEnd().slice(-1);
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; i += 1; out += ' '; }
      else if (c === '/' && next === '*') { state = 'block'; i += 1; out += ' '; }
      else if (c === "'") { state = 'single'; out += c; }
      else if (c === '"') { state = 'double'; out += c; }
      else if (c === '`') { state = 'template'; out += c; }
      // A slash after a value is division; after an operator or a bracket that
      // opens something, it begins a regular expression.
      else if (c === '/' && !/[\w)\]]/.test(prevCode)) { state = 'regex'; out += c; }
      else out += c;
    } else if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
    } else if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; i += 1; }
    } else {
      out += c;
      if (c === '\\') { out += source[i + 1] ?? ''; i += 1; continue; }
      const closes = { single: "'", double: '"', template: '`', regex: '/' };
      if (c === closes[state]) state = 'code';
      else if (state === 'regex' && c === '\n') state = 'code';
    }
  }
  return out;
}

/** Leaf key names declared as rules (shape `true`), which something must read. */
function leafNames(node, shape, found = new Set()) {
  for (const [k, v] of Object.entries(node)) {
    if (k === '$comment' || k === 'schemaVersion') continue;
    const allowed = shape['*'] ?? shape[k];
    if (allowed === true) found.add(k);
    else if (allowed !== undefined && allowed !== 'prose'
      && v && typeof v === 'object' && !Array.isArray(v)) {
      leafNames(v, allowed, found);
    }
  }
  return [...found];
}

/** Leaves declared as explanation (shape `'prose'`), which nothing executes. */
function proseLeaves(node, shape, where = '', found = []) {
  for (const [k, v] of Object.entries(node)) {
    const allowed = shape['*'] ?? shape[k];
    // Named by its full path: eight rows all reporting "rationale" say nothing
    // about which one is empty.
    if (allowed === 'prose') found.push([`${where}${k}`, v]);
    else if (allowed !== undefined && allowed !== true
      && v && typeof v === 'object' && !Array.isArray(v)) {
      proseLeaves(v, allowed, `${where}${k}.`, found);
    }
  }
  return found;
}

function checkRuleTable({ file, table, module: moduleFile, constructorName, exposed, shape,
                          reasonsKey = 'rejectionReasons', extraProducers = [] }) {
  // A comment inside the section is not one of the names: it explains them.
  const declared = Object.keys(table[reasonsKey]).filter((k) => k !== '$comment');
  const thrown = reasonsThrownIn(moduleFile, constructorName, extraProducers);

  check(`${file} every declared reason is thrown somewhere in ${moduleFile}`,
    declared.every((r) => thrown.has(r)),
    `never thrown: ${declared.filter((r) => !thrown.has(r)).join(', ')}`);
  // The scan reads literals. A reason passed as a variable would be invisible to
  // it - the check would keep passing while no longer seeing the code. So the
  // module is required to keep every rejection literal at its throw site.
  const src = readFileSync(join(RULE_MODULE_DIR, moduleFile), 'utf8');
  const nonLiteral = [...src.matchAll(new RegExp(`new ${constructorName}\\(\\s*([^'"\\s][^,)]*)`, 'g'))];
  check(`${file} every rejection in ${moduleFile} names its reason literally`,
    nonLiteral.length === 0,
    nonLiteral.map((m) => m[1].slice(0, 40)).join(' / '));
  check(`${file} every reason ${moduleFile} throws is declared`,
    [...thrown].every((r) => declared.includes(r)),
    `undeclared: ${[...thrown].filter((r) => !declared.includes(r)).join(', ')}`);
  check(`${file} the module exposes exactly the declared reasons`,
    JSON.stringify([...exposed].sort()) === JSON.stringify([...declared].sort()),
    `impl: ${exposed.join(', ')} vs table: ${declared.join(', ')}`);

  // An unknown key is a rule nothing reads. It looks, to anyone opening the
  // file, like one in force. Checking only the top level and the reasons left
  // the nested objects - hash, orderingIsStructural, identity - accepting
  // anything, so the walk covers every level and a nested object whose shape
  // nobody declared fails rather than passing by default.
  const stray = undeclaredKeys(table, shape, file);
  check(`${file} carries no keys the validator does not check`, stray.length === 0,
    stray.join(' / '));

  // Being allowed to exist is not the same as being read. A leaf nobody
  // consults can hold any value at all - naming.extensionRule said "last-dot"
  // beside a splitExtension that hard-codes it, and changing the string to
  // nonsense changed nothing. Every leaf must be read by the module or asserted
  // by this file; a rule that is neither is decoration.
  // Comments are stripped from both sides first: a rule named only in prose
  // about it would satisfy this check while nothing executed it, which is the
  // shape of defect the check exists to find. It nearly passed that way here.
  const validatorSource = withoutComments(readFileSync(fileURLToPath(import.meta.url), 'utf8'));
  const moduleSource = withoutComments(readFileSync(join(RULE_MODULE_DIR, moduleFile), 'utf8'));
  const unread = leafNames(table, shape)
    .filter((k) => !moduleSource.includes(k) && !validatorSource.includes(`.${k}`));
  check(`${file} every rule is read by ${moduleFile} or asserted here`,
    unread.length === 0, unread.join(', '));

  // Prose fields are exempt from the above precisely because nothing reads
  // them, so they have to be prose: a rule quietly relabelled as explanation
  // would otherwise leave the table through this door.
  for (const [name, value] of proseLeaves(table, shape)) {
    check(`${file} ${name} is explanation, and says something`,
      typeof value === 'string' && value.length > 40, JSON.stringify(value));
  }
}

// --- the path rule table and its implementation stay in step ----------------
{
  const pathRules = read(join(schemaDir, 'path-rules.json'));
  const declared = Object.keys(pathRules.rejectionReasons);
  checkRuleTable({
    file: 'path-rules.json', table: pathRules, module: 'path-gate.mjs',
    constructorName: 'Rejected', exposed: REJECTION_REASONS,
    shape: {
      $comment: true, schemaVersion: true,
      rejectionReasons: { '*': { stage: true, rationale: 'prose' } },
      identity: { $comment: true, unicodeNormalization: true, caseInsensitiveDefault: true },
    },
  });
  for (const [name, r] of Object.entries(pathRules.rejectionReasons)) {
    check(`rejection reason ${name} names when it applies and why`,
      ['before_access', 'before_write'].includes(r.stage) && typeof r.rationale === 'string' && r.rationale.length > 20,
      JSON.stringify(r));
  }
  // §13.4 requires resolution BEFORE access. A reason that only applies after
  // the file is open would be describing a check that runs too late.
  check('every reason applies before the filesystem is touched',
    declared.every((n) => pathRules.rejectionReasons[n].stage.startsWith('before_')));
}

// --- the comment scanner the rule check leans on -----------------------------
{
  // The "every rule is read" check is only as good as this: a rule named in a
  // trailing comment used to read as implemented, and a blunt strip of
  // everything after // would eat a URL inside a string and hide a real read.
  const cases = [
    ['const x = 0; // someRule', false, 'a trailing comment'],
    ['/* someRule */ const y = 1;', false, 'a block comment'],
    ['const u = "https://e.com/someRule";', true, 'a string containing //'],
    ['const r = /someRule/.test(s);', true, 'a regular expression'],
    ['const t = `a//someRule`;', true, 'a template literal'],
    ['const d = a / b; // someRule', false, 'division before a trailing comment'],
  ];
  for (const [source, survives, what] of cases) {
    check(`the comment scanner ${survives ? 'keeps' : 'strips'} ${what}`,
      withoutComments(source).includes('someRule') === survives,
      JSON.stringify(withoutComments(source)));
  }
}

// --- the §7.1 mapping and its module stay in step -----------------------------
{
  const det = read(join(schemaDir, 'pdf-detection-rules.json'));
  checkRuleTable({
    file: 'pdf-detection-rules.json', table: det, module: 'pdf-detection.mjs',
    constructorName: 'MappingRefused', exposed: DETECTION_REFUSALS, reasonsKey: 'refusals',
    shape: {
      $comment: true, schemaVersion: true,
      source: { document: true, section: true, atLeast: true },
      mapping: { $comment: 'prose', '*': { categories: true, location: true, detector: true,
        locationNote: 'prose', producesNoFinding: 'prose' } },
      escalation: { $comment: 'prose', '*': { e1Default: true, raiseTo: true,
        condition: true, why: 'prose' } },
      nonEscalating: { $comment: 'prose', '*': 'prose' },
      refusals: { $comment: 'prose', '*': { rationale: 'prose', negativeCase: true } },
    },
  });
  // The module reads the section and the floor; the suite reads the document.
  // Asserted here so the field is not a path nobody checks.
  // Read by the suite, which is a different file, so asserted here - a rule
  // nobody reads is decoration, and the check does not know about suites.
  for (const [name, r] of Object.entries(det.refusals)) {
    if (name === '$comment') continue;
    check(`${name} says where its negative case lives`,
      ['in_suite', 'in_ci'].includes(r.negativeCase), r.negativeCase);
  }
  check('the §7.1 mapping names the case study that exists',
    existsSync(join(schemaDir, '..', '..', det.source.document)), det.source.document);
}

// --- the boundary claims, and the floor under them ---------------------------
{
  const bounds = read(join(schemaDir, 'boundary-rules.json'));
  // The floor exists so that removing a boundary and its claim together cannot
  // pass quietly. A floor that drifts down with the list would be no floor.
  const claimed = Object.keys(bounds.claims).filter((k) => k !== '$comment');
  check('the boundary floor is not below what is claimed',
    bounds.source.atLeast >= claimed.length,
    `floor ${bounds.source.atLeast}, ${claimed.length} claims`);
  check('every claim is either covered or owed, never both or neither',
    claimed.every((k) => {
      const c = bounds.claims[k];
      return Array.isArray(c.coveredBy) !== (typeof c.owedBy === 'string');
    }));
  // A claim names the suite it ran in, because three suites share a check name.
  const unqualified = claimed.flatMap((k) => (bounds.claims[k].coveredBy ?? []))
    .filter((name) => !/^test:[a-z-]+:/.test(name));
  check('every claimed check names the suite it ran in', unqualified.length === 0,
    unqualified.join(' / '));
}

// --- the exit codes, and which status each may appear with --------------------
//
// The command line is a second implementation of this contract. The order the
// conditions are checked in decides what a run with two of them reports, so it
// lives in the table and both implementations walk it; this checks the table
// against the enums it has to agree with.
{
  const exits = read(join(schemaDir, 'exit-code-rules.json'));
  const names = Object.keys(exits.codes);
  const statuses = enumAt('enums.schema.json', '$defs.status.enum');

  const unknownInOrder = exits.order.map((r) => r.code).filter((c) => !names.includes(c));
  check('every ordered condition names a code the table declares',
    unknownInOrder.length === 0, unknownInOrder.join(', '));
  check('the default names a code the table declares', names.includes(exits.default.code),
    exits.default.code);

  const conditions = exits.order.map((r) => r.condition);
  check('no condition is checked twice', new Set(conditions).size === conditions.length,
    conditions.join(', '));

  // Both directions. A status with no row would exit by whatever the code
  // happened to be, and a row for a status that no longer exists is a rule
  // nobody notices has stopped applying.
  const missing = statuses.filter((s) => !(s in exits.statusExitMatrix));
  check('every status says which exit codes it may appear with', missing.length === 0,
    missing.join(', '));
  const stray = Object.keys(exits.statusExitMatrix).filter((s) => !statuses.includes(s));
  check('every row of the matrix names a status that exists', stray.length === 0,
    stray.join(', '));

  const unknownInMatrix = Object.entries(exits.statusExitMatrix)
    .flatMap(([status, codes]) => codes.filter((c) => !names.includes(c)).map((c) => `${status}=${c}`));
  check('every code in the matrix is one the table declares', unknownInMatrix.length === 0,
    unknownInMatrix.join(', '));

  // §12.2 lists these eight numbers. A renumbering would be a contract change
  // and has to be made deliberately rather than by editing one row.
  check('the numbers are the ones §12.2 names',
    JSON.stringify(Object.values(exits.codes).slice().sort((a, b) => a - b))
      === JSON.stringify([0, 2, 3, 4, 5, 6, 7, 8]),
    Object.values(exits.codes).join(', '));

  const severityLeaks = Object.entries(exits.statusExitMatrix)
    .filter(([status, codes]) => ['review_required', 'blocking_findings'].includes(status)
      && !codes.includes('ok'));
  check('severity does not reach the exit code', severityLeaks.length === 0,
    severityLeaks.map(([s]) => s).join(', '));
}

// --- what a run may consume, and what an overrun is called --------------------
{
  const limits = read(join(schemaDir, 'limit-rules.json'));
  checkRuleTable({
    file: 'limit-rules.json', table: limits, module: 'limits.mjs',
    constructorName: 'LimitRefused', exposed: LIMIT_REFUSALS, reasonsKey: 'refusals',
    shape: {
      $comment: true, schemaVersion: true,
      outcomes: { $comment: 'prose', '*': { coverage: true, decidedBefore: true,
        rationale: 'prose' } },
      budgets: { $comment: 'prose', '*': { default: true, unit: true, basis: true,
        measurement: true, note: 'prose', owner: 'prose' } },
      measurement: { $comment: 'prose', runs: true, records: true,
        instrument: 'prose', notTheReferenceMachine: 'prose' },
      basisKinds: { $comment: 'prose', measured: 'prose', decided: 'prose',
        provisional: 'prose' },
      refusals: { '*': { rationale: 'prose' } },
    },
  });

  // The three names come from enums that already existed. Inventing a fourth
  // here would give the same overrun two vocabularies, which is how one gets
  // reported as a skip in one place and a failure in another.
  const skipReasons = enumAt('enums.schema.json', '$defs.coverageSkipReason.enum');
  const failureCodes = enumAt('enums.schema.json', '$defs.detectorFailureCode.enum');
  for (const [name, o] of Object.entries(limits.outcomes)) {
    if (name === '$comment') continue;
    // A misspelling falls into the other branch rather than failing: "faield"
    // is not "skipped", so it is looked for among the failure codes and found.
    // The value has to be one of the two the result schema has.
    check(`${name} has a coverage the result schema knows`,
      ['skipped', 'failed'].includes(o.coverage), JSON.stringify(o.coverage));
    const home = o.coverage === 'skipped' ? skipReasons : failureCodes;
    check(`${name} is a name the result schema already has`, home.includes(name),
      `${o.coverage} vocabulary is ${home.join(', ')}`);
  }

  // The discriminator, enforced rather than described. A skip is only honest
  // when nothing was attempted, so an outcome decided before work starts is a
  // skip and every other one is a failure - which is the whole boundary #39
  // asks to be settled, in one assertion.
  for (const [name, o] of Object.entries(limits.outcomes)) {
    if (name === '$comment') continue;
    const beforeAnyWork = o.decidedBefore === 'any work starts';
    check(`${name} is a skip exactly when it is decided before work starts`,
      beforeAnyWork === (o.coverage === 'skipped'),
      `${o.coverage} but decided before ${o.decidedBefore}`);
  }

  // A number with no unit is a number two people will read differently.
  for (const [name, b] of Object.entries(limits.budgets)) {
    if (name === '$comment') continue;
    check(`${name} says what its number counts`,
      typeof b.unit === 'string' && b.unit.length > 0, JSON.stringify(b.unit));
  }

  // §17.1: unsupported or failed checks mislabelled as completed, 0 cases.
  check('no overrun is reported as a completed check',
    Object.entries(limits.outcomes).filter(([k]) => k !== '$comment')
      .every(([, o]) => o.coverage !== 'completed'));

  // A default nobody has to account for is a guess that gets defended later as
  // though it had been measured. Enforced here rather than as a refusal,
  // because nothing reads a basis while working.
  const unaccounted = budgetsWithoutBasis();
  check('every budget default names where it came from', unaccounted.length === 0,
    unaccounted.join(', '));
  for (const [name, b] of Object.entries(limits.budgets)) {
    if (name === '$comment') continue;
    if (b.basis === 'measured') {
      // includes() on a string matches a substring, so "memory,other" would
      // answer for "memory". The list has to be a list.
      check('the measurement records are a list',
        Array.isArray(limits.measurement.records),
        JSON.stringify(limits.measurement.records));
      check(`${name} names the measurement it came from`,
        Array.isArray(limits.measurement.records)
        && limits.measurement.records.includes(b.measurement), b.measurement);
    }
    if (b.basis === 'provisional') {
      check(`${name} names who owes the real number`,
        typeof b.owner === 'string' && /#\d+/.test(b.owner), b.owner);
    }
    if (b.basis === 'decided') {
      // A decision is allowed. Pretending it was forced is not, so it has to
      // say what the measurement did and did not settle.
      check(`${name} says what the measurement did not settle`,
        typeof b.note === 'string' && b.note.length > 100, b.note?.slice(0, 40));
    }
  }
  // Resolved before it is checked, and required to stay inside tools/: a value
  // of "tools/../package.json" strips to "../package.json", which exists and is
  // not a measurement script.
  const declaredRuns = resolve(RULE_MODULE_DIR, limits.measurement.runs.replace(/^tools\//, ''));
  check('the measurement names a file inside tools/',
    declaredRuns.startsWith(`${resolve(RULE_MODULE_DIR)}/`), declaredRuns);
  check('and that file exists and is a regular file',
    existsSync(declaredRuns) && statSync(declaredRuns).isFile(), limits.measurement.runs);
}

// --- what two runs on one machine may do at once -----------------------------
{
  const conc = read(join(schemaDir, 'concurrency-rules.json'));
  checkRuleTable({
    file: 'concurrency-rules.json', table: conc, module: 'run-registry.mjs',
    constructorName: 'RegistryRefused', exposed: REGISTRY_REFUSALS, reasonsKey: 'refusals',
    shape: {
      $comment: true, schemaVersion: true,
      lock: { $comment: 'prose', scope: true, neverHeldAcross: true,
        neverHeldAcrossReason: 'prose', acquiredBy: true },
      arbitration: { $comment: 'prose', sameInputInspect: 'prose',
        sameInputSanitize: 'prose', sameOutputName: 'prose' },
      record: { $comment: 'prose', fields: true, stages: true, durability: true },
      refusals: { $comment: 'prose', '*': { rationale: 'prose', negativeCase: true } },
    },
  });

  // §11.1 requires per-finding review, so a run stops and waits for a person.
  // A lock held across that turns one open dialog into a machine-wide stall,
  // and the approval is made safe by the input hash rather than by a lock.
  check('the lock is never held across waiting for a person',
    conc.lock.neverHeldAcross === 'waiting for a person');
  check('the lock covers one registry change and no more',
    conc.lock.scope === 'one registry mutation');

  // A registry that forgets at every restart is the in-memory set it replaces.
  check('the registry survives a restart', conc.record.durability.includes('read back on open'));
  // The three §14.1 names, and the identity binding's own list, must agree -
  // two spellings of the same three stages is two things that can drift.
  check('the registry records the same stages the identity binding uses',
    JSON.stringify(conc.record.stages) === JSON.stringify(STAGES), conc.record.stages.join(', '));

  // The lock has to be one two processes cannot both believe they hold, which
  // is the same exclusive create the output protocol reserves names with.
  check('the lock is taken by an exclusive create',
    conc.lock.acquiredBy.startsWith('exclusive-create'));

  // §14.1 allows bounded local threads or processes and rules out a distributed
  // queue. A word search over the table matched the sentence saying so, which
  // is a check firing on its own explanation; a list of forbidden modules was
  // no better - it refused child_process and worker_threads, which §14.1
  // permits, and said nothing about node:tls or a bare fetch.
  //
  // A list of what may be imported is decidable, and wrong in the safe
  // direction: a module reaching for something new has to be added here, which
  // is the decision being forced rather than avoided.
  const ALLOWED_IMPORTS = ['node:fs', './temp-files.mjs'];
  const registrySource = withoutComments(
    readFileSync(join(RULE_MODULE_DIR, 'run-registry.mjs'), 'utf8'));
  const imported = [...registrySource.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const unexpected = imported.filter((i) => !ALLOWED_IMPORTS.includes(i));
  check('the registry imports only what it is allowed to', unexpected.length === 0,
    unexpected.join(', '));
  check('the import scan found the imports at all, so the list is not vacuous',
    imported.length >= 2, `${imported.length} imports`);
}

// --- the temporary file's permissions, place and end -------------------------
{
  const tempRules = read(join(schemaDir, 'temp-rules.json'));
  checkRuleTable({
    file: 'temp-rules.json', table: tempRules, module: 'temp-files.mjs',
    // The refusals are what this module throws. The threats below are the other
    // kind of entry - nothing throws a threat - so they are checked by their
    // own rules rather than squeezed through a scan for throw sites.
    constructorName: 'TempRefused', exposed: TEMP_REFUSALS, reasonsKey: 'refusals',
    // The sweep reports rather than throws: a kept file carries the same
    // vocabulary in `because`, so that is a producing site too.
    extraProducers: ["because: '([a-z_]+)'"],
    shape: {
      $comment: true, schemaVersion: true,
      incompleteMarker: true,
      mode: { $comment: 'prose', octal: true, setAtCreation: true },
      location: { $comment: 'prose', policy: true, reason: 'prose', residualRisk: 'prose' },
      reclamation: { $comment: 'prose', requiresProofOwnerIsGone: true,
        ownerToken: 'prose', ageIsNotProof: 'prose', discovery: true },
      content: { $comment: 'prose', holds: true, neverHolds: true },
      refusals: { $comment: 'prose', '*': { rationale: 'prose' } },
      threats: { '*': { likelihood: 'prose', impact: 'prose', mitigation: 'prose',
        residualRisk: 'prose', testCoverage: true } },
    },
  });

  // §15: each threat carries likelihood, impact, mitigation, residual risk and
  // test coverage. A threat listed without all five is a threat someone looked
  // at, not one that was answered.
  for (const [name, t] of Object.entries(tempRules.threats)) {
    const missing = ['likelihood', 'impact', 'mitigation', 'residualRisk', 'testCoverage']
      .filter((k) => typeof t[k] !== 'string' || t[k].length < 20);
    check(`threat ${name} answers all five §15 questions`, missing.length === 0,
      missing.join(', '));
  }

  // Whether the named check ran is asserted by the suite itself, which knows
  // the names it executed; a search for the text here would be satisfied by a
  // comment, the way the rule-table scan nearly was by its own explanation.
  // What is left here is that a name was given at all.
  for (const [name, t] of Object.entries(tempRules.threats)) {
    check(`threat ${name} names something as its coverage`,
      typeof t.testCoverage === 'string' && t.testCoverage.length > 10, t.testCoverage);
  }

  check('the mode is owner-only', () => !readableByOthers(TEMP_MODE) && TEMP_MODE === 0o600);
  check('the mode is set at creation, not afterwards', tempRules.mode.setAtCreation === true);
  // Age would delete work in progress, which is the cleanup becoming the loss.
  check('reclamation needs proof, not a clock',
    tempRules.reclamation.requiresProofOwnerIsGone === true);
  // A sweep handed its list protects whatever the caller remembered to include.
  check('the sweep finds its own candidates',
    tempRules.reclamation.discovery.startsWith('by marker'));
  check('the marker is the one the failure rules use',
    tempRules.incompleteMarker === read(join(schemaDir, 'failure-rules.json')).incompleteMarker);
}

// --- the failure table and what the publish actually does stay in step -------
{
  const failRules = read(join(schemaDir, 'failure-rules.json'));
  checkRuleTable({
    file: 'failure-rules.json', table: failRules, module: 'failure-semantics.mjs',
    constructorName: 'WriteFailed', exposed: FAILURE_CODES, reasonsKey: 'codes',
    // classify() decides a code and returns it; that is a producing site too.
    extraProducers: ["return '([a-z_]+)';"],
    shape: {
      $comment: true, schemaVersion: true, incompleteMarker: true,
      codes: { '*': { rationale: 'prose' } },
      interruptionPoints: { $comment: 'prose', points: true,
        afterPublishIsComplete: true, afterPublishReason: 'prose' },
      cancellationCheckpoints: { $comment: 'prose', points: true, notAfterPublish: 'prose' },
      invariants: { $comment: 'prose', originalUnchanged: 'prose',
        destinationAbsentOrComplete: 'prose', incompleteWorkIsMarked: 'prose' },
    },
  });

  // A checkpoint is only a checkpoint if the code asks there. Declared lists
  // drift away from the code silently - the list still reads as coverage, and
  // the run answers a cancel later and later - so the two are compared.
  const publishSource = withoutComments(
    readFileSync(join(RULE_MODULE_DIR, 'output-naming.mjs'), 'utf8'));
  const asked = [...publishSource.matchAll(/stop\('([a-z_]+)'\)/g)].map((m) => m[1]);
  check('the publish asks at exactly the declared cancellation checkpoints',
    JSON.stringify([...asked].sort()) === JSON.stringify([...CANCELLATION_CHECKPOINTS].sort()),
    `code: ${asked.join(', ')} vs table: ${CANCELLATION_CHECKPOINTS.join(', ')}`);

  // §12.1: cancellation must not leave a file that appears successfully
  // sanitized. Past the link there is no such file to leave - it is finished -
  // so asking there would throw away work the user already has.
  check('no cancellation checkpoint runs after the publish',
    !CANCELLATION_CHECKPOINTS.includes('after_publish')
    && failRules.interruptionPoints.afterPublishIsComplete === true);

  // Crashes happen where they happen; cancels are noticed where the run asks.
  // Every interruption point must be interrupted by a vector, which the suite
  // asserts - here we only require the two lists to stay distinguishable.
  check('the interruption points cover the write itself, which no checkpoint can',
    INTERRUPTION_POINTS.includes('during_write')
    && !CANCELLATION_CHECKPOINTS.includes('during_write'));
}

// --- the output rule table and its implementation stay in step ---------------
{
  const outRules = read(join(schemaDir, 'output-rules.json'));
  checkRuleTable({
    file: 'output-rules.json', table: outRules, module: 'output-naming.mjs',
    constructorName: 'OutputRejected', exposed: OUTPUT_REJECTIONS,
    shape: {
      $comment: true, schemaVersion: true,
      rejectionReasons: { '*': { rationale: 'prose' } },
      naming: {
        $comment: true, marker: true, sequenceSeparator: true, firstSequenceNumber: true,
        maxAttempts: true, extensionRule: true, extensionRuleLimit: 'prose',
      },
      writeProtocol: {
        $comment: true, claim: true, then: true, tempLocation: true, tempLocationReason: 'prose',
      },
    },
  });
  // §5.2 and §9.3 are about the original, so a marker that can be empty would
  // let the output take the input's name under a spelling the gate allows.
  check('the sanitized marker is not empty',
    typeof outRules.naming.marker === 'string' && outRules.naming.marker.trim().length > 0);
  // Asking whether a name is free and then using it is the concurrent defect
  // §20.2 names. The table must not be able to describe that protocol.
  check('a name is claimed by creating it, not by asking whether it is free',
    outRules.writeProtocol.claim === 'exclusive-create');
  check('the temporary file lives beside its destination, so the rename is atomic',
    outRules.writeProtocol.tempLocation === 'same-directory-as-destination');
  check('the write goes through a temporary file and a link that cannot replace',
    outRules.writeProtocol.then === 'write-temp-then-link');
  // splitExtension hard-codes last-dot, so this is the only thing the table may
  // say. A table describing a rule the code does not implement is worse than no
  // table: it reads as the specification.
  check('the extension rule the table states is the one splitExtension implements',
    outRules.naming.extensionRule === 'last-dot');
}

// --- the identity rule table and its implementation stay in step -------------
{
  const idRules = read(join(schemaDir, 'identity-rules.json'));
  const declared = Object.keys(idRules.rejectionReasons);
  checkRuleTable({
    file: 'identity-rules.json', table: idRules, module: 'file-identity.mjs',
    constructorName: 'IdentityRejected', exposed: IDENTITY_REJECTIONS,
    shape: {
      $comment: true, schemaVersion: true, stages: true,
      rejectionReasons: { '*': { rationale: 'prose' } },
      hash: { algorithm: true, encoding: true, $comment: true },
      orderingIsStructural: { claim: true, howItHolds: true, $comment: true },
    },
  });
  for (const [name, r] of Object.entries(idRules.rejectionReasons)) {
    check(`identity reason ${name} says why it exists`,
      typeof r.rationale === 'string' && r.rationale.length > 20, JSON.stringify(r));
  }
  check('the stages are the three §14.1 names, in order',
    JSON.stringify(idRules.stages) === JSON.stringify(['inspect', 'sanitize', 'verify']));
  // A structural guarantee is not a rejection reason: a reason describes a check
  // that can fire, and one that never can is an enforcement claim the code does
  // not make. The table records the claim separately, with how it holds.
  check('a structural guarantee is recorded as one, not as a reason',
    typeof idRules.orderingIsStructural?.claim === 'string'
    && typeof idRules.orderingIsStructural?.howItHolds === 'string'
    && !declared.includes('bytes_read_before_hashing'));
  check('the hash algorithm matches what the result schema requires',
    idRules.hash.algorithm === 'sha256' && idRules.hash.encoding === 'lowercase-hex');
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  ${Object.keys(manifest).length} examples (${examples.length} inspection), ${negatives.length}+${verifyNegatives.length}+${capNegatives.length} negative cases (inspection/verification/capability), ${enumCats.length} categories, ${failures} failure(s)`);

process.exit(failures === 0 ? 0 : 1);
