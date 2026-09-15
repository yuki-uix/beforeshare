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

// A comment inside the section explains the names; it is not one of them.
export const DETECTION_REFUSALS = Object.keys(RULES.refusals).filter((k) => k !== '$comment');
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

/** Mapping keys the case study no longer lists. */
export function staleMappings(items) {
  return Object.keys(RULES.mapping)
    .filter((k) => k !== '$comment')
    .filter((k) => !items.includes(k));
}

/**
 * Every category some §7.1 item reaches.
 *
 * Takes the items rather than trusting the table's keys. A reworded §7.1 item
 * leaves the old key behind, and its categories went on counting as reached -
 * so a category nothing actually reaches looked covered while the new wording
 * failed separately for being unmapped. Two failures, one of them silent, and
 * the silent one was in the direction this module exists to check.
 */
export function reachableCategories(items) {
  const live = items === undefined
    ? Object.keys(RULES.mapping).filter((k) => k !== '$comment')
    : items.filter((i) => RULES.mapping[i] !== undefined);
  return new Set(live.flatMap((k) => RULES.mapping[k].categories));
}

/**
 * Categories the taxonomy has for PDF that no §7.1 item reaches.
 *
 * Throws rather than returns, because the two directions are one obligation: an
 * unmapped item means a detector invents a category or drops the item, and an
 * unreachable category means the taxonomy carries a value nothing produces -
 * a category that looks supported and is not.
 */
export function assertEveryCategoryIsReached(pdfCategories, items) {
  const reachable = reachableCategories(items);
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
 * Blocking is critical AND deterministic, and there are two ways to get there.
 * E1 set `embedded_file` and `text_under_redaction` to critical, so those block
 * on their defaults and need nothing from this epic. Everything else blocks
 * only through an escalation, on the condition stated with it.
 *
 * An earlier version of this comment said no PDF category defaults to critical.
 * That was true of my assumption and not of category-defaults.json, and it
 * mattered: reading it would tell you that a category absent from the
 * escalation table cannot block, which is the opposite of what the first branch
 * below does.
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
