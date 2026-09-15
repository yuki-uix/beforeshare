/**
 * Vectors for the immutable-output rules.
 *
 * The last case is the one issue #36 asks for by name: every remediation action
 * in the enum, not a sample. The list comes from enums.schema.json, so a ninth
 * action joins it without anyone remembering to.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createGate } from './path-gate.mjs';
import { hashBytes } from './file-identity.mjs';
import {
  claimOutputPath, writeClaimed, candidateName, splitExtension, OUTPUT_REJECTIONS,
} from './output-naming.mjs';

const REMEDIATION_ACTIONS = JSON.parse(
  readFileSync(new URL('../schemas/v1/enums.schema.json', import.meta.url), 'utf8'),
).$defs.remediationAction.enum;

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  let failures = 0;
  const triggered = new Set();
  const fail = (name, detail) => {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  };
  // A suite that dies reports nothing; three of these suites once exited on an
  // unexpected throw and were read as passing because nothing said FAIL.
  process.on('uncaughtException', (e) => {
    fail('the suite aborted instead of reporting a failure', e?.stack ?? String(e));
    console.log(`\nFAIL  immutable output: ${failures} failure(s)`);
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    fail('the suite aborted on a rejected promise', e?.stack ?? String(e));
    console.log(`\nFAIL  immutable output: ${failures} failure(s)`);
    process.exit(1);
  });
  const check = (name, cond, detail) => {
    let value;
    try { value = typeof cond === 'function' ? cond() : cond; }
    catch (e) { fail(name, `threw instead of returning: ${e?.reason ?? e?.message ?? e}`); return; }
    if (value) console.log(`ok    ${name}`);
    else fail(name, detail);
  };
  const rejects = (name, fn, expected) => {
    try { fn(); fail(name, `expected ${expected}, got success`); }
    catch (e) {
      triggered.add(e.reason);
      check(name, e.reason === expected, `expected ${expected}, got ${e.reason ?? e.message}`);
    }
  };

  const ROOT = '/Users/u/Documents';
  const INPUT = `${ROOT}/report.pdf`;

  /** Files keyed by path. createExclusive fails when the name is taken. */
  const mkFs = (seed = { [INPUT]: 'original bytes' }, links = {}) => {
    const files = new Map(Object.entries(seed));
    return {
      files,
      realpath: (p) => links[p] ?? p,
      isDirectory: (p) => p === ROOT,
      read: (p) => {
        if (!files.has(p)) { const e = new Error(p); e.code = 'ENOENT'; throw e; }
        return files.get(p);
      },
      write: (p, bytes) => { files.set(p, bytes); return true; },
      createExclusive: (p) => (files.has(p) ? false : (files.set(p, ''), true)),
      rename: (from, to) => { files.set(to, files.get(from)); files.delete(from); return true; },
    };
  };
  const gateFor = (fs) => createGate({ fs, authorisedRoots: [ROOT] });

  // --- the marker goes where the file stays openable --------------------------
  {
    check('the first name carries the marker before the extension',
      () => candidateName('report.pdf', 1) === 'report (sanitized).pdf');
    check('the second name is numbered from 2',
      () => candidateName('report.pdf', 2) === 'report (sanitized) 2.pdf');
    check('a name with no extension keeps none',
      () => candidateName('report', 1) === 'report (sanitized)');
    // A leading dot is the name, not an extension: treating it as one would
    // produce " (sanitized).bashrc", which names a different file.
    check('a leading dot is part of the name',
      () => splitExtension('.bashrc').extension === ''
        && candidateName('.bashrc', 1) === '.bashrc (sanitized)');
    // Stated, not solved: the MVP media types all carry one extension.
    check('only the final extension is preserved, as the table says',
      () => candidateName('archive.tar.gz', 1) === 'archive.tar (sanitized).gz');
  }

  // --- a taken name is stepped over, not overwritten ---------------------------
  {
    const fs = mkFs({ [INPUT]: 'original bytes', [`${ROOT}/report (sanitized).pdf`]: 'someone else' });
    const g = gateFor(fs);
    const claim = claimOutputPath(fs, g, g.forRead(INPUT));
    check('an occupied name is skipped', () => claim.path === `${ROOT}/report (sanitized) 2.pdf`);
    check('the occupant is untouched',
      () => fs.files.get(`${ROOT}/report (sanitized).pdf`) === 'someone else');
  }

  // --- the name is claimed by creating it, not by asking ----------------------
  {
    const fs = mkFs();
    const g = gateFor(fs);
    // Another process wins the first name in the window a check-then-write would
    // have left open: createExclusive is called, and by then the name is taken.
    const realCreate = fs.createExclusive;
    let raced = false;
    fs.createExclusive = (p) => {
      if (!raced && p === `${ROOT}/report (sanitized).pdf`) {
        raced = true;
        fs.files.set(p, 'the other process');   // it got there first
        return false;
      }
      return realCreate(p);
    };
    const claim = claimOutputPath(fs, g, g.forRead(INPUT));
    check('a name lost to another process is not claimed anyway',
      () => claim.path === `${ROOT}/report (sanitized) 2.pdf`);
    check('the other process keeps what it wrote',
      () => fs.files.get(`${ROOT}/report (sanitized).pdf`) === 'the other process');
  }

  // --- an explicit path does not mean permission to replace -------------------
  {
    const fs = mkFs({ [INPUT]: 'original bytes', [`${ROOT}/chosen.pdf`]: 'already here' });
    const g = gateFor(fs);
    rejects('an explicit destination that exists is refused',
      () => claimOutputPath(fs, g, g.forRead(INPUT), { explicitPath: `${ROOT}/chosen.pdf` }),
      'destination_exists');
    check('the existing file is untouched',
      () => fs.files.get(`${ROOT}/chosen.pdf`) === 'already here');

    let sameFile = false;
    try { claimOutputPath(fs, g, g.forRead(INPUT), { explicitPath: INPUT }); }
    catch (e) { sameFile = e.reason === 'output_is_input'; }
    check('an explicit destination naming the input is refused by the gate', sameFile);
  }

  // --- writing needs a claim and a temp beside the destination -----------------
  {
    const fs = mkFs();
    const g = gateFor(fs);
    let unclaimed = false;
    try { writeClaimed(fs, g, { path: `${ROOT}/forged.pdf` }, 'evil'); }
    catch (e) { unclaimed = /needs a claim/.test(e.message); }
    check('a hand-built claim cannot be written through', unclaimed);

    const claim = claimOutputPath(fs, g, g.forRead(INPUT));
    rejects('a temporary file away from its destination is refused',
      () => writeClaimed(fs, g, claim, 'sanitized', { tempPath: '/Users/u/Documents/sub/x.part' }),
      'temp_outside_destination_directory');

    const written = writeClaimed(fs, g, claim, 'sanitized bytes');
    check('the bytes arrive at the claimed name',
      () => fs.files.get(written) === 'sanitized bytes');
    check('no temporary file is left wearing a partial result',
      () => ![...fs.files.keys()].some((k) => k.endsWith('.part')));
  }

  // --- the temporary file is a path too ---------------------------------------
  {
    // The destination was checked. `<destination>.part` is a different name, so
    // a link planted there is followed unless it goes through the gate as well:
    // the bytes land outside the authorised roots, and the rename then moves
    // whatever is at that name into place.
    const dest = `${ROOT}/report (sanitized).pdf`;
    const fs = mkFs({ [INPUT]: 'original bytes' }, { [`${dest}.part`]: '/etc/passwd' });
    const g = gateFor(fs);
    const claim = claimOutputPath(fs, g, g.forRead(INPUT));
    let refused = false;
    try { writeClaimed(fs, g, claim, 'sanitized bytes'); }
    catch (e) { refused = e.reason === 'symlink_escape'; }
    check('a link planted at the temporary name is refused', refused);
    check('nothing was written outside the authorised roots',
      () => !fs.files.has('/etc/passwd'));
  }

  // --- another run's half-written file is not collateral ----------------------
  {
    const dest = `${ROOT}/report (sanitized).pdf`;
    const fs = mkFs({ [INPUT]: 'original bytes', [`${dest}.part`]: 'another run, mid-write' });
    const g = gateFor(fs);
    const claim = claimOutputPath(fs, g, g.forRead(INPUT));
    rejects('a temporary name belonging to another run is refused',
      () => writeClaimed(fs, g, claim, 'mine'), 'temp_name_taken');
    check("the other run's bytes survive",
      () => fs.files.get(`${dest}.part`) === 'another run, mid-write');
  }

  // --- the original is never resolvable for writing by omission ---------------
  {
    const fs = mkFs();
    const g = gateFor(fs);
    // The refusal used to be opt-in: forWrite without { input } skipped it, and
    // omission looks exactly like forgetting. §17.3 allows no case where a
    // workflow changes the original, so the declaration is mandatory.
    let refused = false;
    try { g.forWrite(INPUT); } catch (e) { refused = /needs \{ input \}/.test(e.message); }
    check('resolving a path for writing without declaring the input is refused', refused);
    check('the original is still what it was', () => fs.files.get(INPUT) === 'original bytes');
  }

  // --- the sequence is finite and says so -------------------------------------
  {
    const seed = { [INPUT]: 'original bytes' };
    for (let n = 1; n <= 1000; n += 1) seed[`${ROOT}/${candidateName('report.pdf', n)}`] = 'taken';
    const fs = mkFs(seed);
    const g = gateFor(fs);
    rejects('an exhausted sequence is refused rather than guessed at',
      () => claimOutputPath(fs, g, g.forRead(INPUT)), 'no_free_name');
  }

  // --- every remediation action leaves the original byte-identical ------------
  {
    // The list is the enum, so this cannot quietly become a sample: a ninth
    // action joins without anyone remembering, and a renamed one fails here.
    check('the action list is the full enum', REMEDIATION_ACTIONS.length === 8,
      `${REMEDIATION_ACTIONS.length} actions`);
    for (const action of REMEDIATION_ACTIONS) {
      const fs = mkFs();
      const g = gateFor(fs);
      const before = hashBytes(fs.files.get(INPUT));
      const claim = claimOutputPath(fs, g, g.forRead(INPUT));
      writeClaimed(fs, g, claim, `bytes after ${action}`);
      const after = hashBytes(fs.files.get(INPUT));
      check(`${action} leaves the original unchanged`, () => before === after,
        `${before.slice(0, 12)} -> ${after.slice(0, 12)}`);
      check(`${action} writes somewhere else`, () => claim.path !== INPUT);
    }
  }

  // --- what the loop above does and does not prove ----------------------------
  {
    // Running the same write path eight times is eight copies of one check. The
    // enum makes it exhaustive over the actions, which is what #36 asks for, but
    // the immutability does not come from those eight passing - it comes from
    // there being exactly one place in this module that writes. That is the part
    // worth asserting, because it is the part a ninth action cannot weaken.
    const src = readFileSync(new URL('./output-naming.mjs', import.meta.url), 'utf8');
    const writers = [...src.matchAll(/^.*\b(?:writeFile\(|fs\.write\(|fs\.rename\()/gm)]
      .map((m) => m[0].trim());
    const inWriteClaimed = src.slice(src.indexOf('export function writeClaimed'));
    const outside = writers.filter((line) => !inWriteClaimed.includes(line));
    check('only writeClaimed writes, so an action cannot acquire its own path',
      outside.length === 0, outside.join(' / '));
    check('the write path was found at all, so the check is not vacuous',
      writers.length >= 2, `${writers.length} writing lines`);
  }

  // --- every declared rejection reason is reachable ---------------------------
  const unreached = OUTPUT_REJECTIONS.filter((r) => !triggered.has(r));
  check('every declared rejection reason is triggered by a vector',
    unreached.length === 0, `never triggered: ${unreached.join(', ')}`);

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  immutable output: ${OUTPUT_REJECTIONS.length} reasons, ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}
