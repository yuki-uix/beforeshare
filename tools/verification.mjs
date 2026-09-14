/**
 * The executable half of the verification contract.
 *
 * §10.2 says only `verified_removed` and `verified_transformed` are successful
 * outcomes, and that the application must not collapse `unable_to_verify` into
 * success. Both sentences were prose until this file existed, and prose is not
 * something the desktop app, the CLI and the MCP server can all be checked
 * against.
 */

export const VERIFICATION_OUTCOMES = [
  'verified_removed',
  'verified_transformed',
  'still_present',
  'unable_to_verify',
  'failed',
];

/** The only two outcomes that may be presented to a user as success (§10.2). */
export const SUCCESSFUL_OUTCOMES = ['verified_removed', 'verified_transformed'];

export function isSuccessfulOutcome(outcome) {
  if (!VERIFICATION_OUTCOMES.includes(outcome)) {
    throw new Error(`unknown verification outcome: ${outcome}`);
  }
  return SUCCESSFUL_OUTCOMES.includes(outcome);
}

/**
 * Whether a whole verification run may be presented as successful.
 *
 * Every requested action must have succeeded. There is deliberately no partial
 * credit: a run where one action verified and another came back
 * `unable_to_verify` is not a successful run, and summarising it as one is the
 * exact collapse §10.2 forbids.
 *
 * @returns {{successful: boolean, reason: string}}
 */
export function summariseVerification(result) {
  const results = result?.results ?? [];
  if (results.length === 0) {
    return { successful: false, reason: 'no action was verified' };
  }

  // Compared by index, not as sets. `requested` has no uniqueItems and its
  // entries are {action, findingIds}, so the same action legitimately appears
  // twice — two findings each asking for a metadata removal. A set comparison
  // would then accept one result for two requests and call the run successful
  // with an action never verified. The schema already states that `results` has
  // one entry per requested action, ordered to match, so index comparison covers
  // count and order at once.
  const requested = result.requested ?? [];
  if (results.length !== requested.length) {
    return {
      successful: false,
      reason: `${requested.length} action(s) requested but ${results.length} result(s) returned`,
    };
  }
  const mismatched = requested
    .map((r, i) => (results[i].action === r.action ? null : `position ${i}: requested ${r.action}, got ${results[i].action}`))
    .filter(Boolean);
  if (mismatched.length > 0) {
    return { successful: false, reason: mismatched.join('; ') };
  }

  const bad = results.filter((r) => !isSuccessfulOutcome(r.outcome));
  if (bad.length > 0) {
    return {
      successful: false,
      reason: bad.map((r) => `${r.action}: ${r.outcome}`).join('; '),
    };
  }

  // A preservation check that ran and found a change beyond its tolerance is an
  // unintended change to the user's file (§10.3), whatever the removals did.
  const broken = Object.entries(result.preservation ?? {})
    .filter(([, m]) => m.outcome === 'changed_beyond_tolerance')
    .map(([k]) => k);
  if (broken.length > 0) {
    return { successful: false, reason: `content not preserved: ${broken.join(', ')}` };
  }

  return { successful: true, reason: 'every requested action verified and content was preserved' };
}
