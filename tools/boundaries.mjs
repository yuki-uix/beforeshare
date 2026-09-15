/**
 * §20.2's safety boundaries, and whether anything actually covers them.
 *
 * The list is read out of the case study rather than written down here. A list
 * transcribed into a file of mine would be checked against my own copy: add a
 * boundary to §20.2 and nothing would notice, which is the failure this exists
 * to prevent. Read from the source, a new boundary arrives with nothing
 * claiming it.
 *
 * A reference implementation of schemas/v1/boundary-rules.json, not the product
 * runtime. The core language is still undecided.
 */
import { readFileSync } from 'node:fs';
import { bulletsUnder } from './case-study.mjs';

const RULES = JSON.parse(
  readFileSync(new URL('../schemas/v1/boundary-rules.json', import.meta.url), 'utf8'),
);

export const BOUNDARY_SOURCE = RULES.source;

export class BoundaryUnclaimed extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
  }
}

/**
 * The boundaries, as the case study writes them.
 *
 * Parsed rather than copied, and the parse is required to find something: a
 * regex that silently matches nothing would report perfect coverage of an
 * empty list.
 */
export function boundariesFromCaseStudy(text) {
  try {
    // atLeast 1 here, not the declared floor: this catches a parse that found
    // nothing, which would report perfect coverage of an empty list. The floor
    // that says "§20.2 has not shrunk" belongs to the suite, which reports it
    // as a failed check rather than dying - a suite that aborts says less than
    // one that names what is wrong.
    return bulletsUnder(text, RULES.source.section, { atLeast: 1 });
  } catch (e) {
    // Re-thrown in this module's vocabulary, because the table declares these
    // reasons and the two-way check would otherwise find one it never throws.
    if (e.reason === 'section_not_found') {
      throw new BoundaryUnclaimed('section_not_found',
        `${RULES.source.section} is not in ${RULES.source.document}`);
    }
    throw new BoundaryUnclaimed('no_boundaries_found', e.message);
  }
}

/** What the table claims about one boundary. */
export function claimFor(boundary) {
  const claim = RULES.claims[boundary];
  if (claim === undefined) {
    throw new BoundaryUnclaimed('boundary_unclaimed',
      `${JSON.stringify(boundary)} is in §${RULES.source.section} and nothing here claims it`);
  }
  const hasChecks = Array.isArray(claim.coveredBy) && claim.coveredBy.length > 0;
  const hasOwner = typeof claim.owedBy === 'string' && claim.owedBy.length > 0;
  if (hasChecks === hasOwner) {
    throw new BoundaryUnclaimed('claim_is_ambiguous',
      `${boundary} is ${hasChecks ? 'both covered and owed' : 'neither covered nor owed'}`);
  }
  return claim;
}

/** Claims for boundaries the case study no longer lists. */
export function staleClaims(boundaries) {
  return Object.keys(RULES.claims)
    .filter((k) => k !== '$comment')
    .filter((k) => !boundaries.includes(k));
}

export { RULES as BOUNDARY_RULES };
