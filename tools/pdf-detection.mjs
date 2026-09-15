/**
 * How §7.1's disclosure categories reach the canonical result.
 *
 * The taxonomy, the location union and the severity defaults all exist already;
 * what was missing is the mapping between them, and a mapping is exactly the
 * kind of thing that gets decided by accident inside an implementation. Written
 * down, it can be checked in both directions: an item nothing maps, and a
 * category nothing reaches.
 *
 * A reference implementation of schemas/v1/pdf-detection-rules.json, not the
 * product runtime. The core language is settled (ADR 0001) and the port is #62.
 */
import { readFileSync } from 'node:fs';

const RULES = JSON.parse(
  readFileSync(new URL('../schemas/v1/pdf-detection-rules.json', import.meta.url), 'utf8'),
);

export const DETECTION_REFUSALS = Object.keys(RULES.refusals);
export const ESCALATABLE = Object.keys(RULES.escalation).filter((k) => k !== '$comment');
export const CONSIDERED_AND_NOT_RAISED = Object.keys(RULES.nonEscalating).filter((k) => k !== '$comment');

export class MappingRefused extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
  }
}

/** What a §7.1 item becomes, or why it becomes nothing. */
export function mappingFor(item) {
  const entry = RULES.mapping[item];
  if (entry === undefined) {
    throw new MappingRefused('item_unmapped',
      `${JSON.stringify(item)} is in §${RULES.source.section} and nothing maps it`);
  }
  const silent = entry.categories.length === 0 && typeof entry.producesNoFinding !== 'string';
  if (silent) {
    throw new MappingRefused('item_unmapped',
      `${item} maps to no category and does not say why; an item that yields nothing is a decision, not an omission`);
  }
  return entry;
}

/** Every category some §7.1 item reaches. */
export function reachableCategories() {
  return new Set(Object.entries(RULES.mapping)
    .filter(([k]) => k !== '$comment')
    .flatMap(([, v]) => v.categories));
}

/**
 * Categories the taxonomy has for PDF that no §7.1 item reaches.
 *
 * Throws rather than returns, because the two directions are one obligation: an
 * unmapped item means a detector invents a category or drops the item, and an
 * unreachable category means the taxonomy carries a value nothing produces -
 * a category that looks supported and is not.
 */
export function assertEveryCategoryIsReached(pdfCategories) {
  const reachable = reachableCategories();
  const unreachable = pdfCategories.filter((c) => !reachable.has(c));
  if (unreachable.length > 0) {
    throw new MappingRefused('category_unreachable',
      `${unreachable.join(', ')} exist for PDF and no §${RULES.source.section} item reaches them`);
  }
  return true;
}

/**
 * Whether a finding in this category may block.
 *
 * Blocking is critical AND deterministic, and no PDF category defaults to
 * critical - so blocking is reachable only by an escalation, and only on the
 * condition stated with it. A category absent from the escalation table cannot
 * block, which is a structural fact rather than a policy someone remembers.
 */
export function mayBlock(category, defaults) {
  const byDefault = defaults?.[category];
  if (byDefault?.defaultSeverity === 'critical' && byDefault?.defaultCertainty === 'deterministic') {
    return true;
  }
  return ESCALATABLE.includes(category);
}

/** The condition under which a category may be raised, refusing a bare claim. */
export function escalationFor(category) {
  const entry = RULES.escalation[category];
  // What it overrides, to what, when, and why. A raise that does not say what
  // it is overriding is one epic overruling another in a file the first would
  // not think to read.
  const complete = entry !== undefined
    && typeof entry.e1Default === 'string'
    && entry.raiseTo === 'critical'
    && typeof entry.condition === 'string' && entry.condition.length > 20
    && typeof entry.why === 'string' && entry.why.length > 80;
  if (!complete) {
    throw new MappingRefused('escalation_unexplained',
      `${category} is raised without saying what it overrides and why: ${JSON.stringify(entry)}`);
  }
  return entry;
}

export { RULES as PDF_DETECTION_RULES };
