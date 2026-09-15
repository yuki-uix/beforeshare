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
  const heading = new RegExp(`^###\\s+${RULES.source.section.replace('.', '\\.')}\\s`, 'm');
  const start = text.search(heading);
  if (start === -1) {
    throw new BoundaryUnclaimed('section_not_found',
      `${RULES.source.section} is not in ${RULES.source.document}`);
  }
  const rest = text.slice(start);
  const end = rest.slice(1).search(/^###\s/m);
  const section = end === -1 ? rest : rest.slice(0, end + 1);
  const items = [...section.matchAll(/^-\s+(.+?);?\s*$/gm)].map((m) => m[1].replace(/\.$/, ''));
  if (items.length === 0) {
    throw new BoundaryUnclaimed('no_boundaries_found',
      `${RULES.source.section} has no bullet list; a parse that finds nothing reports perfect coverage of nothing`);
  }
  return items;
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
