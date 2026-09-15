/**
 * What a run may consume before it stops, and how stopping is reported.
 *
 * §17.1 puts "unsupported or failed checks mislabelled as completed" at zero,
 * so the interesting part is not the stopping - it is that an overrun becomes
 * the same outcome wherever it happens. Three vocabularies already existed for
 * this before anyone said which applied when: coverageSkipReason's
 * input_too_large, and detectorFailureCode's resource_limit_exceeded and
 * timeout. The table decides, not the caller.
 *
 * A reference implementation of schemas/v1/limit-rules.json, not the product
 * runtime. The core language is still undecided.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const RULES = JSON.parse(
  readFileSync(new URL('../schemas/v1/limit-rules.json', import.meta.url), 'utf8'),
);

export const LIMIT_REFUSALS = Object.keys(RULES.refusals);
export const OUTCOMES = Object.keys(RULES.outcomes).filter((k) => k !== '$comment');
export const BASIS_KINDS = Object.keys(RULES.basisKinds).filter((k) => k !== '$comment');
export const DEFAULT_BUDGETS = Object.freeze(Object.fromEntries(
  Object.entries(RULES.budgets).filter(([k]) => k !== '$comment')
    .map(([k, v]) => [k, v.default]),
));

export class LimitExceeded extends Error {
  constructor(outcome, detail) {
    super(`${outcome}: ${detail}`);
    /** The name from the table, so a caller cannot relabel the same overrun. */
    this.outcome = outcome;
    this.coverage = RULES.outcomes[outcome].coverage;
  }
}

export class LimitRefused extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
  }
}

/**
 * Decide before anything is opened.
 *
 * This is the only check that can produce a skip, because it is the only one
 * that happens before work starts: nothing was attempted, so nothing partial
 * exists. Every later overrun is a failure.
 */
export function admit(sizeBytes, budgets = DEFAULT_BUDGETS) {
  assertDeclared(budgets, 'inputBytes');
  if (sizeBytes > budgets.inputBytes) {
    throw new LimitExceeded('input_too_large',
      `${sizeBytes} bytes, limit ${budgets.inputBytes}`);
  }
  return true;
}

/**
 * A budget that is spent rather than declared.
 *
 * Returned as something the work must call, so a detector that ignores it is
 * visibly not using it - a limit checked once at the top is a limit a loop can
 * run past for ever.
 */
export function budget(budgets = DEFAULT_BUDGETS, { now = () => performance.now() } = {}) {
  assertDeclared(budgets, 'expansionRatio');
  assertDeclared(budgets, 'graphDepth');
  assertDeclared(budgets, 'wallClockMs');
  const startedAt = now();
  let consumed = 0;
  let produced = 0;
  let depth = 0;

  const checkClock = () => {
    const elapsed = now() - startedAt;
    if (elapsed > budgets.wallClockMs) {
      throw new LimitExceeded('timeout', `${Math.round(elapsed)}ms, limit ${budgets.wallClockMs}ms`);
    }
  };

  return {
    /** Bytes read from the input, which the ratio below is measured against. */
    consume(bytes) {
      consumed += bytes;
      checkClock();
      return consumed;
    },

    /**
     * Bytes a decompressor produced. The ratio is what catches a bomb: a small
     * stream that expands without end passes any absolute byte ceiling set
     * high enough to allow a large legitimate file.
     */
    produce(bytes) {
      produced += bytes;
      checkClock();
      if (consumed > 0 && produced / consumed > budgets.expansionRatio) {
        throw new LimitExceeded('resource_limit_exceeded',
          `expanded ${produced} from ${consumed}, ratio limit ${budgets.expansionRatio}`);
      }
      return produced;
    },

    /**
     * Enter a nested object. A PDF object graph can contain a cycle, so depth
     * is bounded rather than trusted to terminate - and the counter has to be
     * released on the way out, or a wide graph looks like a deep one.
     */
    enter(label) {
      depth += 1;
      checkClock();
      if (depth > budgets.graphDepth) {
        throw new LimitExceeded('resource_limit_exceeded',
          `depth ${depth} at ${label}, limit ${budgets.graphDepth}`);
      }
      return () => { depth -= 1; };
    },

    /** For a caller that wants to stop early rather than be stopped. */
    spent() {
      return { consumed, produced, depth, elapsedMs: now() - startedAt };
    },
  };
}

/** How an overrun is reported, decided by the table rather than by the caller. */
export function coverageFor(outcome) {
  const entry = RULES.outcomes[outcome];
  if (entry === undefined) {
    throw new LimitRefused('budget_exceeded', `${outcome} is not one of ${OUTCOMES.join(', ')}`);
  }
  return entry.coverage;
}

function assertDeclared(budgets, name) {
  if (budgets === null || typeof budgets !== 'object' || typeof budgets[name] !== 'number') {
    throw new LimitRefused('budget_not_declared',
      `${name} was not declared; an undeclared budget is an opt-in limit, and the case it exists for is the one nobody opted into`);
  }
}

/** Every budget accounts for its default, from the closed set of bases. */
export function budgetsWithoutBasis() {
  return Object.entries(RULES.budgets)
    .filter(([name]) => name !== '$comment')
    .filter(([, v]) => !BASIS_KINDS.includes(v.basis))
    .map(([name]) => name);
}

export { RULES as LIMIT_RULES };
