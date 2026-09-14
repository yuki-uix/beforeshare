/**
 * Reference implementation of the status decision table in
 * docs/contracts/status-and-exit-codes.md.
 *
 * §8.1 lists six status values and does not say how to choose between them. This
 * is that choice, in one place, so the desktop app, the CLI and the MCP server
 * cannot each invent their own (§14.1).
 *
 * The function returns the status AND the reason it was chosen. The reason is not
 * decoration: "why does this file say partial" is a question users ask, and a
 * status computed without a traceable cause is one nobody can argue with when it
 * is wrong.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const INPUTS = JSON.parse(readFileSync(join(here, '..', 'schemas', 'v1', 'status-inputs.json'), 'utf8'));

export const SUPPORTED_MEDIA_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];

/** A finding blocks only when it is both critical and deterministic. */
export function isBlocking(finding) {
  return finding.severity === INPUTS.blockingRule.severity
    && finding.certainty === INPUTS.blockingRule.certainty;
}

/** Skips that mean "this detector had nothing to do here" do not reduce coverage. */
export function reducesCoverage(skipReason) {
  const row = INPUTS.skipReasons[skipReason];
  if (!row) throw new Error(`unclassified skip reason: ${skipReason}`);
  return row.reducesCoverage;
}

/** Derived from the result itself, never from a caller-supplied flag: whether a
 * media type is in scope is a fact about the file, and letting each interface
 * decide it separately is exactly the divergence §14.1 forbids. */
export function isUnsupportedMediaType(result) {
  const mediaType = result?.input?.mediaType;
  if (!mediaType) return false;
  return !SUPPORTED_MEDIA_TYPES.includes(mediaType);
}

/**
 * @param {object} result  A canonical inspection result, minus its own `status`.
 * @param {object} [run]   The ONLY fact a result cannot carry about itself:
 *                         { unusable: boolean } — the run died before producing
 *                         anything coherent. Nothing else is accepted here; in
 *                         particular there is no caller override for media-type
 *                         scope, because an override is exactly the per-interface
 *                         divergence deriving it was meant to prevent.
 * @returns {{status: string, reason: string}}
 */
export function computeStatus(result, run = {}) {
  const coverage = result.coverage ?? { completed: [], skipped: [], failed: [] };
  const findings = result.findings ?? [];
  const unsupportedMediaType = isUnsupportedMediaType(result);

  // The order of these branches IS the decision table in
  // docs/contracts/status-and-exit-codes.md, row for row. Reordering one without
  // the other produces a document that describes a different product.

  // 1. The run died before producing anything coherent.
  if (run.unusable) {
    return { status: 'failed', reason: 'the run could not produce a result' };
  }

  // 2. BeforeShare does not handle this kind of file at all. Checked BEFORE the
  //    zero-detector case: an out-of-scope file naturally has no completed
  //    detectors, and reporting that as `failed` would blame the run for
  //    something that is a property of the input. Nothing went wrong here.
  if (unsupportedMediaType) {
    return { status: 'unsupported', reason: 'the media type is outside the supported set' };
  }

  // 3. In scope, but nothing completed. The result carries no information about
  //    the file, so it must not be described in terms of what was or was not found.
  if (coverage.completed.length === 0) {
    return {
      status: 'failed',
      reason: 'no detector completed, so the result describes nothing about the file',
    };
  }

  const gaps = [
    ...coverage.skipped.filter((s) => reducesCoverage(s.reason)).map((s) => s.detector),
    ...coverage.failed.map((f) => f.detector),
  ];
  // A cancelled run stopped before it was done, whether or not any detector got
  // as far as recording a `cancelled` skip. inspection-result.schema.json states
  // that a cancelled run is never `no_findings`; this is where that holds.
  if (result.cancelled) gaps.push('(run cancelled before completion)');
  const blocking = findings.filter(isBlocking);

  // 4. A blocking finding outranks incomplete coverage. Incompleteness does not
  //    make a critical, deterministic finding less true, and the incompleteness
  //    itself is not lost: `coverage` and `limitations` are required fields and
  //    the exit code still reports it (see docs/contracts/status-and-exit-codes.md).
  if (blocking.length > 0) {
    return {
      status: 'blocking_findings',
      reason: `${blocking.length} critical deterministic finding(s): ${blocking.map((f) => f.category).join(', ')}`,
    };
  }

  // 5. Incomplete coverage outranks ordinary findings. `partial` is the only
  //    value that says "this list is not exhaustive", and that caveat has to
  //    survive: a user who fixes the three listed findings under a
  //    `review_required` headline would reasonably believe they were done.
  if (gaps.length > 0) {
    return { status: 'partial', reason: `checks did not run: ${gaps.join(', ')}` };
  }

  // 6. Complete coverage, findings present.
  if (findings.length > 0) {
    return { status: 'review_required', reason: `${findings.length} finding(s) to review` };
  }

  // 7. Complete coverage, nothing found. The only state that may be presented as
  //    clean — and only because every branch above has been ruled out.
  return { status: 'no_findings', reason: 'all applicable checks completed with nothing to report' };
}
