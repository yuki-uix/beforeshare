/**
 * Vectors for the immutable-output rules.
 *
 * The last case is the one issue #36 asks for by name: every remediation action
 * in the enum, not a sample. The list comes from enums.schema.json, so a ninth
 * action joins it without anyone remembering to.
 */
import { readFileSync, mkdtempSync, writeFileSync, symlinkSync, openSync, closeSync, linkSync, rmSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
      readlink(p) {
        if (Object.prototype.hasOwnProperty.call(links, p)) return links[p];
        throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
      },
      isDirectory: (p) => p === ROOT,
      read: (p) => {
        if (!files.has(p)) { const e = new Error(p); e.code = 'ENOENT'; throw e; }
        return files.get(p);
      },
      write: (p, bytes) => { files.set(p, bytes); return true; },
      // O_CREAT|O_EXCL fails on an existing name and does NOT follow a symlink
      // there, so a planted link counts as occupied. A stub that consulted only
      // real files would let a vector assert behaviour no filesystem has.
      createExclusive: (p) => (
        files.has(p) || Object.hasOwn(links, p) ? false : (files.set(p, ''), true)
      ),
      // link refuses an existing name and never follows a symlink to one, which
      // is what makes it a publish that cannot replace.
      link: (from, to) => (
        files.has(to) || Object.hasOwn(links, to) ? false : (files.set(to, files.get(from)), true)
      ),
      unlink: (p) => files.delete(p),
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
    const written = writeClaimed(fs, g, claim, 'mine');
    check('an occupied name is skipped', () => written === `${ROOT}/report (sanitized) 2.pdf`);
    check('the occupant is untouched',
      () => fs.files.get(`${ROOT}/report (sanitized).pdf`) === 'someone else');
  }

  // --- the destination is never replaced, whenever it appeared ----------------
  {
    const fs = mkFs();
    const g = gateFor(fs);
    const claim = claimOutputPath(fs, g, g.forRead(INPUT));
    // Another process takes the name after the claim and before the publish. A
    // placeholder plus a rename would have overwritten this file: the
    // placeholder is gone, and rename does not ask what it is replacing.
    fs.files.set(`${ROOT}/report (sanitized).pdf`, 'appeared after the claim');
    const written = writeClaimed(fs, g, claim, 'mine');
    check('a destination that appeared after the claim is not replaced',
      () => fs.files.get(`${ROOT}/report (sanitized).pdf`) === 'appeared after the claim');
    check('the result goes to the next free name instead',
      () => written === `${ROOT}/report (sanitized) 2.pdf` && fs.files.get(written) === 'mine');
    check('the temporary file does not survive the publish',
      () => ![...fs.files.keys()].some((k) => k.endsWith('.part')));
  }

  // --- an explicit path does not mean permission to replace -------------------
  {
    const fs = mkFs({ [INPUT]: 'original bytes', [`${ROOT}/chosen.pdf`]: 'already here' });
    const g = gateFor(fs);
    // One candidate, no fallback, and the answer is authoritative at publish.
    const claim = claimOutputPath(fs, g, g.forRead(INPUT), { explicitPath: `${ROOT}/chosen.pdf` });
    rejects('an explicit destination that exists is refused',
      () => writeClaimed(fs, g, claim, 'mine'), 'destination_exists');
    check('the existing file is untouched',
      () => fs.files.get(`${ROOT}/chosen.pdf`) === 'already here');
    check('the temporary file is cleaned up when the publish is refused',
      () => ![...fs.files.keys()].some((k) => k.endsWith('.part')));

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
    // The temporary name is derived, not supplied, so it is always beside the
    // destination: a link only works within one filesystem, and a temporary
    // file elsewhere would fail at publish with all the work already done.
    check('the temporary file sits beside the destination it will become',
      () => claim.temp.path === `${claim.path}.part`);

    const written = writeClaimed(fs, g, claim, 'sanitized bytes');
    check('the bytes arrive at the claimed name',
      () => fs.files.get(written) === 'sanitized bytes');
    check('no temporary file is left wearing a partial result',
      () => ![...fs.files.keys()].some((k) => k.endsWith('.part')));
  }

  // --- the temporary file is a path too ---------------------------------------
  {
    // The destination was checked. `<destination>.part` is a different name, so
    // a link planted there is followed unless it goes through the gate too: the
    // bytes land outside the authorised roots, and the publish then moves
    // whatever is at that name into place.
    const dest = `${ROOT}/report (sanitized).pdf`;
    const fs = mkFs({ [INPUT]: 'original bytes' }, { [`${dest}.part`]: '/etc/passwd' });
    const g = gateFor(fs);
    // The reservation is the temporary file, so the gate sees it before any
    // work is done: the link is refused as what it is, not as a busy name.
    rejects('a link planted at the temporary name is refused',
      () => claimOutputPath(fs, g, g.forRead(INPUT)), 'symlink_escape');
    check('no file was created at the unvetted temporary name',
      () => !fs.files.has(`${dest}.part`));
    check('nothing was written outside the authorised roots',
      () => !fs.files.has('/etc/passwd'));
  }

  // --- another run's half-written file is not collateral ----------------------
  {
    const dest = `${ROOT}/report (sanitized).pdf`;
    const fs = mkFs({ [INPUT]: 'original bytes', [`${dest}.part`]: 'another run, mid-write' });
    const g = gateFor(fs);
    // Each candidate carries its own temporary name, so a busy one is stepped
    // over. Tying the reservation to the first candidate alone stopped a second
    // run from starting at all while the first was writing, with every free
    // name behind it unreachable.
    const claim = claimOutputPath(fs, g, g.forRead(INPUT));
    check('a busy temporary name moves the run to the next candidate',
      () => claim.temp.path === `${ROOT}/report (sanitized) 2.pdf.part`);
    check("the other run's bytes survive",
      () => fs.files.get(`${dest}.part`) === 'another run, mid-write');
    check('two runs on one input reach different destinations',
      () => writeClaimed(fs, g, claim, 'mine') === `${ROOT}/report (sanitized) 2.pdf`);

    // An explicit path has one candidate, so there is nowhere to step to: the
    // busy temporary name is the answer rather than a detour.
    const fs2 = mkFs({ [INPUT]: 'x', [`${ROOT}/chosen.pdf.part`]: 'another run' });
    const g2 = gateFor(fs2);
    rejects('an explicit destination whose temporary name is busy is refused',
      () => claimOutputPath(fs2, g2, g2.forRead(INPUT), { explicitPath: `${ROOT}/chosen.pdf` }),
      'temp_name_taken');
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
    // Every candidate is taken, so the reservation still succeeds - the
    // temporary names are free - and the publish is where it runs out.
    const claim = claimOutputPath(fs, g, g.forRead(INPUT));
    rejects('an exhausted sequence is refused rather than guessed at',
      () => writeClaimed(fs, g, claim, 'mine'), 'no_free_name');
    check('nothing was left behind when no name could be had',
      () => ![...fs.files.keys()].some((k) => k.endsWith('.part')));
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
    const writers = [...src.matchAll(/^.*\b(?:writeFile\(|fs\.write\(|fs\.link\(|fs\.unlink\()/gm)]
      .map((m) => m[0].trim());
    const inWriteClaimed = src.slice(src.indexOf('export function writeClaimed'));
    const outside = writers.filter((line) => !inWriteClaimed.includes(line));
    check('only writeClaimed writes, so an action cannot acquire its own path',
      outside.length === 0, outside.join(' / '));
    check('the write path was found at all, so the check is not vacuous',
      writers.length >= 2, `${writers.length} writing lines`);
  }

  // --- the stub agrees with a real filesystem ---------------------------------
  {
    // The vectors above are only worth anything if createExclusive and rename
    // behave here the way they behave on disk. This repository has been wrong
    // about that before: path-gate's realpath was documented as returning null
    // for a missing path, no filesystem does that, and every vector ran against
    // the stub that did. So the two are compared directly.
    const dir = mkdtempSync(`${tmpdir()}/beforeshare-output-`);
    try {
      const realCreateExclusive = (p) => {
        try { closeSync(openSync(p, 'wx')); return true; } catch { return false; }
      };
      const fresh = `${dir}/fresh.part`;
      const taken = `${dir}/taken.part`;
      const linked = `${dir}/linked.part`;
      writeFileSync(taken, 'someone else');
      symlinkSync('/etc/passwd', linked);

      const stub = mkFs({ [taken]: 'someone else' }, { [linked]: '/etc/passwd' });
      for (const [name, path] of [['a free name', fresh], ['an existing file', taken],
        ['a symlink', linked]]) {
        // Each is called exactly once: creating is the side effect under test,
        // so asking twice - even only to build a message - answers differently.
        const onDisk = realCreateExclusive(path);
        const inStub = stub.createExclusive(path);
        check(`exclusive create on ${name} agrees with node:fs`,
          onDisk === inStub, `${path}: node:fs ${onDisk}, stub ${inStub}`);
      }
      // The link must still point where it did: a create that followed it would
      // have truncated the target instead of failing.
      check('a refused create did not follow the link',
        () => readlinkSync(linked) === '/etc/passwd');

      // The publish primitive matters more than the create: this is the step
      // that must refuse an existing name rather than replace it.
      const realLink = (from, to) => {
        try { linkSync(from, to); return true; } catch { return false; }
      };
      const payload = `${dir}/payload.part`;
      const free = `${dir}/free.pdf`;
      const occupied = `${dir}/occupied.pdf`;
      writeFileSync(payload, 'mine');
      writeFileSync(occupied, 'someone else');
      const stub2 = mkFs({ [payload]: 'mine', [occupied]: 'someone else' });
      for (const [name, to] of [['a free name', free], ['an occupied name', occupied]]) {
        const onDisk = realLink(payload, to);
        const inStub = stub2.link(payload, to);
        check(`publishing onto ${name} agrees with node:fs`, onDisk === inStub,
          `node:fs ${onDisk}, stub ${inStub}`);
      }
      check('the occupant was not replaced by the refused publish',
        () => readFileSync(occupied, 'utf8') === 'someone else');
      check('the published file carries the payload',
        () => readFileSync(free, 'utf8') === 'mine');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // --- every declared rejection reason is reachable ---------------------------
  const unreached = OUTPUT_REJECTIONS.filter((r) => !triggered.has(r));
  check('every declared rejection reason is triggered by a vector',
    unreached.length === 0, `never triggered: ${unreached.join(', ')}`);

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  immutable output: ${OUTPUT_REJECTIONS.length} reasons, ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}
