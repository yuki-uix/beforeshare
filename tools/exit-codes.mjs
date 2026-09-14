/**
 * Reference implementation of the CLI exit-code contract (§12.2).
 *
 * The central decision: **the exit code describes the run, the status describes
 * the result.** They are different questions and neither is derivable from the
 * other.
 *
 *   status      — what did we find in this file?
 *   exit code   — was this run complete and usable?
 *
 * That is why finding severity never changes the exit code. §12.2 requires
 * severity to be communicated in the JSON result rather than encoded in the exit
 * code, so `no_findings`, `review_required` and `blocking_findings` all exit 0:
 * in each case the command completed and a valid result is on stdout.
 *
 * The consequence is deliberate and worth stating plainly to anyone scripting
 * against this: `beforeshare inspect f.pdf && upload f.pdf` will upload a file
 * with critical findings. A script must read the JSON. An exit code is not a
 * safety verdict, and a contract that let it look like one would be the same
 * "misleading safe language" §15 lists as a threat.
 */

export const EXIT = {
  OK: 0,
  INVALID_ARGUMENTS: 2,
  UNSUPPORTED_INPUT: 3,
  PARTIAL_INSPECTION: 4,
  PROCESSING_FAILURE: 5,
  VERIFICATION_FAILURE: 6,
  UNSAFE_OUTPUT_PATH: 7,
  APPROVAL_REQUIRED: 8,
};

/**
 * Conditions are checked in this order. The order runs outward-in: things that
 * stop the command before it touches the file, then things that put the file out
 * of scope, then things that went wrong during the run, then completeness.
 *
 * @param {object} outcome
 * @param {boolean} [outcome.invalidArguments]
 * @param {boolean} [outcome.unsafeOutputPath]   output path resolves to the input, or escapes via a symlink
 * @param {boolean} [outcome.approvalRequired]   a confirmation-required action was requested without approval
 * @param {boolean} [outcome.unsupportedMediaType]
 * @param {boolean} [outcome.processingFailure]
 * @param {boolean} [outcome.verificationFailure] a verification stage returned still_present, unable_to_verify or failed
 * @param {boolean} [outcome.coverageIncomplete]
 * @returns {{code: number, reason: string}}
 */
export function exitCodeFor(outcome = {}) {
  if (outcome.invalidArguments) {
    return { code: EXIT.INVALID_ARGUMENTS, reason: 'arguments were rejected before any file was opened' };
  }
  if (outcome.unsafeOutputPath) {
    return { code: EXIT.UNSAFE_OUTPUT_PATH, reason: 'the requested output path was refused' };
  }
  if (outcome.approvalRequired) {
    return { code: EXIT.APPROVAL_REQUIRED, reason: 'the requested action needs explicit approval that was not given' };
  }
  if (outcome.unsupportedMediaType) {
    return { code: EXIT.UNSUPPORTED_INPUT, reason: 'the input is outside the supported formats' };
  }
  if (outcome.processingFailure) {
    return { code: EXIT.PROCESSING_FAILURE, reason: 'the run could not complete' };
  }
  if (outcome.verificationFailure) {
    return { code: EXIT.VERIFICATION_FAILURE, reason: 'verification did not confirm the requested removal' };
  }
  // Reached even when the status is `blocking_findings`: an inspection that did
  // not look everywhere is a partial inspection regardless of what it did find.
  // This is the one place the exit code and the status deliberately disagree.
  if (outcome.coverageIncomplete) {
    return { code: EXIT.PARTIAL_INSPECTION, reason: 'some checks did not run' };
  }
  return { code: EXIT.OK, reason: 'the command completed and a result is available' };
}

/** Which exit codes each status can legitimately appear with. */
export const STATUS_EXIT_MATRIX = {
  no_findings: [EXIT.OK],
  review_required: [EXIT.OK],
  blocking_findings: [EXIT.OK, EXIT.PARTIAL_INSPECTION],
  partial: [EXIT.PARTIAL_INSPECTION],
  unsupported: [EXIT.UNSUPPORTED_INPUT],
  failed: [EXIT.PROCESSING_FAILURE],
};
