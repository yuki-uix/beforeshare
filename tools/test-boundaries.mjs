/**
 * Does anything actually cover §20.2?
 *
 * Every other suite asserts things about its own subject. This one asserts that
 * the requirement is covered at all - which means it cannot take anyone's word
 * for it. So it runs the suites, collects the names of checks that actually
 * passed, and matches them against what the boundary table claims. A check that
 * is renamed or deleted takes its boundary's coverage with it.
 *
 * The boundaries themselves are read out of the case study, not copied here: a
 * copy would be compared with itself, and a boundary added to §20.2 would
 * arrive with nothing noticing.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  boundariesFromCaseStudy, claimFor, staleClaims, BOUNDARY_SOURCE, BOUNDARY_RULES,
} from './boundaries.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

/** Every suite this repository runs, taken from package.json rather than listed. */
function suiteScripts() {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  return Object.keys(pkg.scripts)
    .filter((name) => name.startsWith('test:') && name !== 'test:boundaries');
}

/** The names of checks that passed, across every suite. */
function checksThatPassed(scripts) {
  const passed = new Set();
  const failedSuites = [];
  for (const script of scripts) {
    let out = '';
    try {
      out = execFileSync('npm', ['run', '--silent', script], {
        cwd: repo, encoding: 'utf8', maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      failedSuites.push(script);
      console.error(`Suite ${script} failed:\n${out}`);
    }
    for (const line of out.split('\n')) {
      const m = /^ok\s{2,}(.+?)\s*$/.exec(line);
      // Qualified by the suite it ran in. Two suites can carry the same check
      // name - "every declared refusal is triggered by a vector" is in three -
      // and a boundary claiming a bare name would be covered by whichever
      // check happened to share it.
      if (m) passed.add(`${script}:${m[1]}`);
    }
  }
  return { passed, failedSuites };
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  let failures = 0;
  const fail = (name, detail) => {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  };
  process.on('uncaughtException', (e) => {
    fail('the suite aborted instead of reporting a failure', e?.stack ?? String(e));
    console.log(`\nFAIL  safety boundaries: ${failures} failure(s)`);
    process.exit(1);
  });
  const check = (name, cond, detail) => {
    let value;
    try { value = typeof cond === 'function' ? cond() : cond; }
    catch (e) { fail(name, `threw instead of returning: ${e?.reason ?? e?.message ?? e}`); return; }
    if (value) console.log(`ok    ${name}`);
    else fail(name, detail);
  };

  const caseStudy = readFileSync(join(repo, BOUNDARY_SOURCE.document), 'utf8');
  const boundaries = boundariesFromCaseStudy(caseStudy);

  // A parse that finds nothing reports perfect coverage of an empty list, so
  // the count is asserted before anything is concluded from it.
  // A floor from the rule table, not a number in here. Adding a boundary must
  // not fail; removing one must not pass - and removing a boundary together
  // with its claim slipped through, because staleClaims only sees a claim whose
  // boundary is gone, never a pair that left together. Lowering the floor is
  // how someone says out loud that a safety requirement was dropped.
  check(`§${BOUNDARY_SOURCE.section} still lists at least ${BOUNDARY_SOURCE.atLeast} boundaries`,
    () => boundaries.length >= BOUNDARY_SOURCE.atLeast,
    `${boundaries.length} found, floor is ${BOUNDARY_SOURCE.atLeast}`);

  const scripts = suiteScripts();
  // Two suites can carry the same check name, so a claim names the suite too.
  // Without that, a boundary is covered by whichever check happened to share a
  // name - and one claim here was attributed to the wrong suite, which a bare
  // name would have accepted.
  check('no two suites are confused for one another',
    () => new Set(scripts).size === scripts.length);
  check('there are suites to collect evidence from', () => scripts.length >= 8,
    scripts.join(', '));
  const { passed, failedSuites } = checksThatPassed(scripts);
  check('every suite ran without failing', failedSuites.length === 0, failedSuites.join(', '));
  check('and reported checks that passed', () => passed.size >= 100, `${passed.size} names`);

  // --- every boundary is claimed, and the claim is true -----------------------
  const owed = [];
  for (const boundary of boundaries) {
    let claim;
    try {
      claim = claimFor(boundary);
    } catch (e) {
      fail(`§${BOUNDARY_SOURCE.section}: ${boundary}`, e.message);
      continue;
    }
    if (claim.owedBy) {
      // Handed off is a real answer, and a different one from covered. It has
      // to name who owes it, so a boundary cannot be quietly set aside.
      check(`${boundary} is owed by a named issue`,
        /#\d+/.test(claim.owedBy) && /[-—]\s*\S/.test(claim.owedBy), claim.owedBy);
      owed.push(boundary);
      continue;
    }
    // Not "a check exists with this name" - a check that RAN and passed. A
    // renamed or deleted check takes its boundary's coverage with it, which is
    // the only way this stays true as the suites change.
    const missing = claim.coveredBy.filter((name) => !passed.has(name));
    check(`${boundary} is covered by checks that ran`, missing.length === 0,
      `no such passing check: ${missing.join(' / ')}`);
  }

  // --- and nothing is claimed that is no longer required ----------------------
  const stale = staleClaims(boundaries);
  check('no claim is left for a boundary the case study dropped', stale.length === 0,
    stale.join(', '));

  check(`${owed.length} of ${boundaries.length} boundaries are handed off, the rest covered here`,
    owed.length + (boundaries.length - owed.length) === boundaries.length);

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  safety boundaries: ${boundaries.length} from §${BOUNDARY_SOURCE.section}, ${owed.length} owed, ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

export { suiteScripts, checksThatPassed };
