/**
 * What an interruption is allowed to leave behind.
 *
 * §17.5 puts "interrupted remediation producing an apparently valid final
 * output" at zero cases. The publish protocol already makes that structural -
 * the destination is created by a link, atomically, only once every byte is in
 * the temporary file - so this module is about the rest: naming the failure
 * instead of swallowing it, and not leaving debris under a name that reads as
 * finished work.
 *
 * A reference implementation of schemas/v1/failure-rules.json, not the product
 * runtime. The core language is still undecided.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const RULES = JSON.parse(
  readFileSync(new URL('../schemas/v1/failure-rules.json', import.meta.url), 'utf8'),
);

export const INTERRUPTION_POINTS = RULES.interruptionPoints.points;
export const CANCELLATION_CHECKPOINTS = RULES.cancellationCheckpoints.points;
export const FAILURE_CODES = Object.keys(RULES.codes);
export const INCOMPLETE_MARKER = RULES.incompleteMarker;

export class WriteFailed extends Error {
  constructor(code, detail, { left } = {}) {
    super(`${code}: ${detail}`);
    this.code = code;
    /** What survived, so a caller can say so rather than guess. */
    this.left = left ?? 'nothing';
  }
}

/**
 * A cancellation a caller can trip, and the run can ask about.
 *
 * Deliberately not a boolean the caller reads: §17.4 asks for cancellation
 * latency to be reported, which needs the moment it was asked for and the
 * moment the work stopped. A flag records neither.
 */
/**
 * @param {object} [opts]  now() must be monotonic. Date.now() is not: an NTP
 *   step or a hand-set clock between asking and stopping produces a negative
 *   latency, and a negative duration in a performance report is worse than no
 *   number - it is a number someone may average.
 */
export function cancellation({ now = () => performance.now() } = {}) {
  let requestedAt = null;
  let observedAt = null;
  return {
    cancel() { if (requestedAt === null) requestedAt = now(); },
    get requested() { return requestedAt !== null; },
    /** Called at each interruption point; throws once cancellation was asked for. */
    throwIfCancelled(point) {
      if (requestedAt === null) return;
      if (observedAt === null) observedAt = now();
      throw new WriteFailed('cancelled', `stopped at ${point}`);
    },
    /**
     * Milliseconds between asking and stopping, or null if it never stopped.
     * Null is the honest answer: reporting 0 for a run that ignored the request
     * would make an unresponsive build look like the fastest one.
     */
    get latencyMs() {
      return requestedAt === null || observedAt === null ? null : observedAt - requestedAt;
    },
  };
}

/**
 * Give a filesystem error a code from the table.
 *
 * ENOSPC and EACCES are separated because the remedy differs: telling someone
 * to free space when they need access sends them the wrong way. Everything else
 * is write_failed rather than a guess - a cause nobody established is worse
 * than an unclassified one, and both are better than a success.
 */
export function classify(error) {
  if (error instanceof WriteFailed) return error.code;
  const code = error?.code;
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'disk_full';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'permission_denied';
  return 'write_failed';
}

/** Whether a name is work in progress rather than a result. */
export function isIncomplete(path) {
  return path.endsWith(INCOMPLETE_MARKER);
}

export { RULES as FAILURE_RULES };
