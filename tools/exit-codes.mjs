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

import { readFileSync } from 'node:fs';

/**
 * The table, read rather than restated. The command line is a second
 * implementation of this contract, and an order written twice is an order two
 * runs can disagree about.
 */
const RULES = JSON.parse(
  readFileSync(new URL('../schemas/v1/exit-code-rules.json', import.meta.url), 'utf8'));

export const EXIT = Object.fromEntries(
  Object.entries(RULES.codes).map(([name, code]) => [name.toUpperCase(), code]));

/**
 * Conditions are checked in the table's order, which runs outward-in: things
 * that stop the command before it touches the file, then things that put the
 * file out of scope, then things that went wrong during the run, then
 * completeness.
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
  for (const row of RULES.order) {
    if (outcome[row.condition]) {
      return { code: RULES.codes[row.code], reason: row.reason };
    }
  }
  return { code: RULES.codes[RULES.default.code], reason: RULES.default.reason };
}

/** Which exit codes each status can legitimately appear with. */
export const STATUS_EXIT_MATRIX = Object.fromEntries(
  Object.entries(RULES.statusExitMatrix)
    .map(([status, names]) => [status, names.map((n) => RULES.codes[n])]));

