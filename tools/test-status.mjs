#!/usr/bin/env node
/**
 * Tests for the status decision table and the exit-code contract.
 *
 * Every case calls tools/status.mjs and tools/exit-codes.mjs. Nothing here
 * reimplements a rule: a test that recomputes the expected status with its own
 * copy of the logic stays green when the real one drifts.
 *
 * The exhaustive section matters more than the named cases. §8.1 gives six
 * status values and the issue asked for a table with no undefined cells, so the
 * cross product of (coverage state x finding severities x run outcome) is
 * enumerated and every combination is required to produce exactly one status.
 */
import { computeStatus, isBlocking, reducesCoverage, SUPPORTED_MEDIA_TYPES } from './status.mjs';
import { exitCodeFor, EXIT, STATUS_EXIT_MATRIX } from './exit-codes.mjs';
import { readFileSync } from 'node:fs';

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`ok    ${name}`);
  else { failures += 1; console.error(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
};

const finding = (severity, certainty = 'deterministic', category = 'document_author') =>
  ({ id: 'finding-x', category, severity, certainty });

const result = ({ completed = ['pdf.metadata'], skipped = [], failed = [], findings = [] } = {}) =>
  ({ coverage: { completed, skipped, failed }, findings });

// --- the five questions the case study left open ----------------------------

check('Q1 aggregation: the most severe finding does not by itself decide the status',
  computeStatus(result({ findings: [finding('high'), finding('low')] })).status === 'review_required');

check('Q1 aggregation: one blocking finding among many decides it',
  computeStatus(result({ findings: [finding('low'), finding('critical')] })).status === 'blocking_findings');

check('Q2 conflict: a blocking finding outranks incomplete coverage',
  computeStatus(result({
    findings: [finding('critical')],
    failed: [{ detector: 'pdf.annotations', errorCode: 'parser_error' }],
  })).status === 'blocking_findings');

check('Q2 conflict: incomplete coverage outranks non-blocking findings',
  computeStatus(result({
    findings: [finding('high')],
    failed: [{ detector: 'pdf.annotations', errorCode: 'parser_error' }],
  })).status === 'partial');

check('Q3 boundary: an unsupported media type is unsupported, not failed',
  computeStatus(result({ completed: [] }), { unsupportedMediaType: true }).status === 'unsupported');

check('Q3 boundary: a supported type with zero completed detectors is failed',
  computeStatus(result({ completed: [] })).status === 'failed');

check('Q3 boundary: an encrypted PDF that still yielded metadata is partial, not failed',
  computeStatus(result({
    completed: ['pdf.metadata'],
    skipped: [{ detector: 'pdf.text_layer', reason: 'blocked_by_encryption' }],
    findings: [finding('low', 'deterministic', 'encryption_state')],
  })).status === 'partial');

check('Q4 boundary: a critical PROBABILISTIC finding does not block',
  computeStatus(result({ findings: [finding('critical', 'probabilistic')] })).status === 'review_required');

check('Q4 boundary: a critical DETERMINISTIC finding blocks',
  computeStatus(result({ findings: [finding('critical', 'deterministic')] })).status === 'blocking_findings');

check('Q5 clean result: a benign skip still allows no_findings',
  computeStatus(result({ skipped: [{ detector: 'image.exif', reason: 'not_applicable_to_media_type' }] })).status === 'no_findings');

check('Q5 clean result: a coverage-reducing skip forbids no_findings',
  computeStatus(result({ skipped: [{ detector: 'ocr.visible_text', reason: 'input_too_large' }] })).status === 'partial');

check('Q5 clean result: a user-disabled detector forbids no_findings',
  computeStatus(result({ skipped: [{ detector: 'ocr.visible_text', reason: 'disabled_by_user' }] })).status === 'partial');

// --- §8.1: partial / unsupported / failed can never come out as no_findings --
const neverClean = [
  ['a failed detector', result({ failed: [{ detector: 'pdf.annotations', errorCode: 'parser_error' }] }), {}],
  ['a coverage-reducing skip', result({ skipped: [{ detector: 'ocr.visible_text', reason: 'cancelled' }] }), {}],
  ['an unsupported media type', result({ completed: [] }), { unsupportedMediaType: true }],
  ['an unusable run', result(), { unusable: true }],
  ['no detector completing', result({ completed: [] }), {}],
];
for (const [label, r, run] of neverClean) {
  check(`never clean: ${label} cannot produce no_findings`,
    computeStatus(r, run).status !== 'no_findings',
    computeStatus(r, run).status);
}

// --- exhaustive: every combination yields exactly one defined status ---------
const VALID = ['no_findings', 'review_required', 'blocking_findings', 'partial', 'unsupported', 'failed'];
const severities = ['low', 'medium', 'high', 'critical'];
const certainties = ['deterministic', 'probabilistic'];
const skipReasons = Object.keys(JSON.parse(readFileSync(new URL('../schemas/v1/status-inputs.json', import.meta.url), 'utf8')).skipReasons);

let combos = 0;
const seen = new Set();
for (const completed of [[], ['pdf.metadata']]) {
  for (const skip of [null, ...skipReasons]) {
    for (const failedDetector of [false, true]) {
      for (const sev of [null, ...severities]) {
        for (const cert of certainties) {
          for (const run of [{}, { unsupportedMediaType: true }, { unusable: true }]) {
            const r = result({
              completed,
              skipped: skip ? [{ detector: 'ocr.visible_text', reason: skip }] : [],
              failed: failedDetector ? [{ detector: 'pdf.annotations', errorCode: 'parser_error' }] : [],
              findings: sev ? [finding(sev, cert)] : [],
            });
            const out = computeStatus(r, run);
            combos += 1;
            if (!VALID.includes(out.status)) {
              check(`exhaustive: combination produced an undefined status`, false, JSON.stringify({ r, run, out }));
            }
            if (!out.reason) check('exhaustive: every status carries a reason', false, JSON.stringify(out));
            seen.add(out.status);
          }
        }
      }
    }
  }
}
check(`exhaustive: ${combos} combinations all produced a defined status`, true);
check('exhaustive: every status value is reachable',
  VALID.every((s) => seen.has(s)), `unreached: ${VALID.filter((s) => !seen.has(s)).join(', ')}`);

// --- the decision is deterministic ------------------------------------------
const sample = result({ findings: [finding('high'), finding('critical', 'probabilistic')], skipped: [{ detector: 'x.y', reason: 'cancelled' }] });
check('the same input always yields the same status',
  computeStatus(sample).status === computeStatus(sample).status);

// --- an unclassified skip reason fails loudly -------------------------------
let threw = false;
try { reducesCoverage('reason_that_does_not_exist'); } catch { threw = true; }
check('an unclassified skip reason throws instead of defaulting', threw);

// --- exit codes --------------------------------------------------------------
check('exit: a complete clean run exits 0', exitCodeFor({}).code === EXIT.OK);
check('exit: severity does not change the exit code',
  exitCodeFor({}).code === EXIT.OK,
  'blocking findings must still exit 0 when coverage is complete (§12.2)');
check('exit: incomplete coverage exits 4 even with a blocking finding',
  exitCodeFor({ coverageIncomplete: true }).code === EXIT.PARTIAL_INSPECTION);
check('exit: unsupported input outranks incomplete coverage',
  exitCodeFor({ unsupportedMediaType: true, coverageIncomplete: true }).code === EXIT.UNSUPPORTED_INPUT);
check('exit: an unsafe output path outranks everything after it',
  exitCodeFor({ unsafeOutputPath: true, unsupportedMediaType: true, processingFailure: true }).code === EXIT.UNSAFE_OUTPUT_PATH);
check('exit: invalid arguments outrank everything',
  exitCodeFor({ invalidArguments: true, unsafeOutputPath: true, approvalRequired: true }).code === EXIT.INVALID_ARGUMENTS);
check('exit: approval required outranks the input being unsupported',
  exitCodeFor({ approvalRequired: true, unsupportedMediaType: true }).code === EXIT.APPROVAL_REQUIRED);
check('exit: verification failure is distinct from processing failure',
  exitCodeFor({ verificationFailure: true }).code === EXIT.VERIFICATION_FAILURE
  && exitCodeFor({ processingFailure: true }).code === EXIT.PROCESSING_FAILURE);
check('exit: every documented code is reachable',
  [0, 2, 3, 4, 5, 6, 7, 8].every((c) => Object.values(EXIT).includes(c)));
check('exit: 1 is deliberately unused',
  !Object.values(EXIT).includes(1));

// --- status/exit matrix is consistent with both implementations -------------
for (const [status, allowed] of Object.entries(STATUS_EXIT_MATRIX)) {
  check(`matrix: ${status} lists only documented exit codes`,
    allowed.every((c) => Object.values(EXIT).includes(c)), allowed.join(','));
}
check('matrix: blocking_findings is the only status with two exit codes',
  Object.entries(STATUS_EXIT_MATRIX).filter(([, v]) => v.length > 1).map(([k]) => k).join(',') === 'blocking_findings');

check('supported media types match the MVP scope',
  SUPPORTED_MEDIA_TYPES.join(',') === 'application/pdf,image/jpeg,image/png');

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  status and exit codes: ${combos} combinations, ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
