/**
 * The temporary file's permissions, place, and end.
 *
 * Each threat in temp-rules.json names a vector here by its exact text, and the
 * validator checks that the name is found. "Mitigated, tested" is the sentence
 * that stops anyone looking again, so the sentence has to be true.
 */
import {
  mkdtempSync, statSync, openSync, closeSync, rmSync, writeFileSync, readFileSync,
  realpathSync, readlinkSync, readdirSync, linkSync, unlinkSync, lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createGate } from './path-gate.mjs';
import { claimOutputPath, writeClaimed } from './output-naming.mjs';
import { cancellation } from './failure-semantics.mjs';
import {
  TEMP_MODE, TEMP_REFUSALS, ownerToken, isReclaimable, sweep, readableByOthers,
  findTemporaryFiles,
} from './temp-files.mjs';

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  let failures = 0;
  const refused = new Set();
  /** Names of checks this run actually executed, for the coverage claim below. */
  const ran = new Set();
  const fail = (name, detail) => {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  };
  process.on('uncaughtException', (e) => {
    fail('the suite aborted instead of reporting a failure', e?.stack ?? String(e));
    console.log(`\nFAIL  temporary files: ${failures} failure(s)`);
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    fail('the suite aborted on a rejected promise', e?.stack ?? String(e));
    console.log(`\nFAIL  temporary files: ${failures} failure(s)`);
    process.exit(1);
  });
  const check = (name, cond, detail) => {
    ran.add(name);
    let value;
    try { value = typeof cond === 'function' ? cond() : cond; }
    catch (e) { fail(name, `threw instead of returning: ${e?.reason ?? e?.message ?? e}`); return; }
    if (value) console.log(`ok    ${name}`);
    else fail(name, detail);
  };
  const refuses = (name, fn, expected) => {
    try { fn(); check(name, false, `expected ${expected}, got success`); }
    catch (e) {
      refused.add(e.reason);
      check(name, e.reason === expected, `expected ${expected}, got ${e.reason ?? e.message}`);
    }
  };

  const ROOT = '/Users/u/Documents';
  const INPUT = `${ROOT}/report.pdf`;

  /** Records the mode each file was created with, the way a filesystem does. */
  const mkFs = () => {
    const files = new Map([[INPUT, 'original']]);
    const modes = new Map();
    return {
      files,
      modes,
      realpath: (p) => p,
      readlink() { throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' }); },
      isDirectory: (p) => p === ROOT,
      read: (p) => files.get(p),
      write: (p, bytes) => (files.set(p, bytes), true),
      createExclusive: (p, { mode } = {}) => (
        files.has(p) ? false : (files.set(p, ''), modes.set(p, mode), true)
      ),
      link: (from, to) => (files.has(to) ? false : (files.set(to, files.get(from)), true)),
      unlink: (p) => files.delete(p),
    };
  };
  const gateFor = (fs) => createGate({ fs, authorisedRoots: [ROOT] });

  // --- a temporary file is owner-only, and not readable by group or other -----
  {
    const fs = mkFs();
    const g = gateFor(fs);
    const claim = claimOutputPath(fs, g, g.forRead(INPUT));
    check('the temporary file is created with a mode at all',
      () => fs.modes.get(claim.temp.path) !== undefined);
    check('a temporary file is owner-only, and not readable by group or other',
      () => !readableByOthers(fs.modes.get(claim.temp.path)),
      `mode ${(fs.modes.get(claim.temp.path) ?? 0).toString(8)}`);

    // A stub that records whatever it was handed proves the call, not the
    // result - and creating a file here with openSync would prove node:fs, not
    // this module. So the publish runs for real, on a real directory, through
    // an adapter that implements createExclusive the way one would: an
    // implementation that dropped { mode }, or created wide and chmodded after,
    // fails here and nowhere else.
    const dir = mkdtempSync(`${tmpdir()}/beforeshare-temp-`);
    try {
      const realInput = `${dir}/report.pdf`;
      writeFileSync(realInput, 'original');
      const adapter = {
        realpath: (p) => { try { return realpathSync(p); } catch { return p; } },
        readlink: (p) => readlinkSync(p),
        isDirectory: (p) => { try { return lstatSync(p).isDirectory(); } catch { return false; } },
        read: (p) => readFileSync(p, 'utf8'),
        write: (p, bytes) => (writeFileSync(p, bytes), true),
        createExclusive: (p, { mode } = {}) => {
          try { closeSync(openSync(p, 'wx', mode)); return true; } catch { return false; }
        },
        link: (from, to) => { try { linkSync(from, to); return true; } catch { return false; } },
        unlink: (p) => { try { unlinkSync(p); return true; } catch { return false; } },
        list: (d) => readdirSync(d),
      };
      const realGate = createGate({ fs: adapter, authorisedRoots: [realpathSync(dir)] });
      const realClaim = claimOutputPath(adapter, realGate, realGate.forRead(realInput));
      const onDisk = statSync(realClaim.temp.path).mode & 0o777;
      // umask only clears bits, so the property is that nothing beyond the
      // owner's is set. An `or` between two spellings of 0600 would have read
      // like a check while only one branch ever ran.
      check('the publish creates it owner-only on a real filesystem',
        () => (onDisk & ~TEMP_MODE & 0o777) === 0 && !readableByOthers(onDisk),
        `mode ${onDisk.toString(8)} vs ${TEMP_MODE.toString(8)}`);
      writeClaimed(adapter, realGate, realClaim, 'sanitized');
      check('and the temporary file is gone once it has published',
        () => readdirSync(dir).every((n) => !n.endsWith('.part')), readdirSync(dir).join(', '));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // --- the three exits cleanup can reach --------------------------------------
  {
    // One name, run for each exit. The label is detail, not part of the name: a
    // threat naming this as its coverage should mean all three paths, and a
    // name that varied per path would let it mean whichever one still existed.
    // "Cleanup happens" otherwise means "cleanup happens on the path I was
    // thinking about".
    for (const [label, run] of [
      ['a successful publish', (fs, g, claim) => writeClaimed(fs, g, claim, 'sanitized')],
      ['a cancelled run', (fs, g, claim) => {
        const c = cancellation();
        c.cancel();
        try { writeClaimed(fs, g, claim, 'sanitized', { cancellation: c }); } catch { /* expected */ }
      }],
      ['a failed write', (fs, g, claim) => {
        fs.write = () => { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; };
        try { writeClaimed(fs, g, claim, 'sanitized'); } catch { /* expected */ }
      }],
    ]) {
      const fs = mkFs();
      const g = gateFor(fs);
      const claim = claimOutputPath(fs, g, g.forRead(INPUT));
      run(fs, g, claim);
      check('the temporary file does not outlive the publish',
        () => !fs.files.has(claim.temp.path), label);
    }
    // The fourth exit is a crash, where cleanup does not run at all - that one
    // is answered by the sweep, below.
  }

  // --- the temporary file holds the sanitized output, never the input --------
  {
    const fs = mkFs();
    const g = gateFor(fs);
    const claim = claimOutputPath(fs, g, g.forRead(INPUT));
    // Declaring what it holds is not enforcing it. What is enforceable is that
    // exactly the bytes handed to the publish arrive there and nothing else -
    // so an implementation that staged a copy of the input would be visible.
    fs.write = (p, bytes) => (fs.files.set(p, bytes), true);
    const seen = [];
    const realWrite = fs.write;
    fs.write = (p, bytes) => { seen.push([p, bytes]); return realWrite(p, bytes); };
    writeClaimed(fs, g, claim, 'sanitized');
    check('only the sanitized bytes are ever written to the temporary file',
      () => seen.length === 1 && seen[0][1] === 'sanitized',
      seen.map(([p, b]) => `${p}=${b}`).join(', '));
    // Exactly one file holds the input's bytes: the input. Written as a count
    // because `!xs.length > 1` parses as `(!xs.length) > 1`, which is false for
    // every input - an assertion that reads like a check and never fires.
    check('the original was never copied anywhere',
      () => [...fs.files.values()].filter((v) => v === 'original').length === 1,
      [...fs.files.entries()].map(([k, v]) => `${k}=${v}`).join(', '));
  }

  // --- a crash leaves an orphan, and the sweep is what cleans it up -----------
  {
    // The AC asks for the temporary file to be cleaned up on the crash path -
    // but a crash is precisely the path on which cleanup does not run, as #37
    // established. So the crash path's cleanup is the sweep, and this is where
    // the two halves meet. Testing only success, cancel and failure would have
    // left the AC's third case answered by a `finally` that a dead process
    // never reaches.
    const fs = mkFs();
    const g = gateFor(fs);
    const claim = claimOutputPath(fs, g, g.forRead(INPUT));
    fs.files.set(claim.temp.path, 'half the sanitized bytes');   // the process died here
    const owner = ownerToken({ pid: 777, startedAt: 5 });
    const host = { processIsRunning: () => false };              // it is gone

    fs.list = (dir) => [...fs.files.keys()]
      .filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1));
    const found = findTemporaryFiles(fs, ROOT);
    check('the orphan is found by its marker, not by being handed over',
      () => found.length === 1 && found[0] === claim.temp.path, found.join(', '));

    const { removed } = sweep(fs, host, found.map((path) => ({ path, owner })));
    check('a crash leaves an orphan that the sweep reclaims',
      () => removed.length === 1 && !fs.files.has(claim.temp.path));
    check('the input is untouched by the sweep', () => fs.files.get(INPUT) === 'original');
  }

  // --- the delete exit checks the marker, not just the finder -----------------
  {
    // A caller can skip findTemporaryFiles. With the owner reported gone, a
    // sweep that trusts its list would delete whatever it was handed - the
    // user's own input included. Every path out of this module passes the same
    // gate, which is the two-way check this repository already asks for.
    const fs = mkFs();
    const gone = { processIsRunning: () => false };
    const owner = ownerToken({ pid: 9, startedAt: 9 });
    const { removed, kept } = sweep(fs, gone, [{ path: INPUT, owner }]);
    check('a path without the marker is not deleted, whoever owns it',
      () => removed.length === 0 && kept[0].because === 'not_a_temporary_file');
    check('the input survives a sweep that was pointed at it',
      () => fs.files.get(INPUT) === 'original');
    refused.add('not_a_temporary_file');
  }

  // --- a host that cannot list a directory sweeps nothing ---------------------
  {
    const fs = mkFs();
    refuses('a host that cannot list a directory is refused, not handed a list',
      () => findTemporaryFiles(fs, ROOT), 'cannot_enumerate');
  }

  // --- a temporary file whose owner may be alive is never reclaimed -----------
  {
    const alive = ownerToken({ pid: 4242, startedAt: 1000 });
    const dead = ownerToken({ pid: 4243, startedAt: 2000 });
    const host = {
      processIsRunning: (o) => o.pid === 4242 && o.startedAt === 1000,
    };
    check('a temporary file whose owner may be alive is never reclaimed',
      () => isReclaimable(host, alive) === false);
    check('one whose owner is gone may be', () => isReclaimable(host, dead) === true);

    // A recycled process id wearing a different start time is a different
    // process. Matching on the id alone would call this owner alive and keep
    // the orphan for ever - or, the other way round, reclaim a live file.
    const recycled = ownerToken({ pid: 4242, startedAt: 9999 });
    check('a recycled process id is not the original owner',
      () => isReclaimable(host, recycled) === true);

    const fs = mkFs();
    fs.files.set(`${ROOT}/a.part`, 'live work');
    fs.files.set(`${ROOT}/b.part`, 'abandoned');
    const { removed, kept } = sweep(fs, host, [
      { path: `${ROOT}/a.part`, owner: alive },
      { path: `${ROOT}/b.part`, owner: dead },
    ]);
    check('the sweep removes the orphan', () => removed.length === 1 && removed[0].endsWith('b.part'));
    check('the sweep keeps the live one and says why',
      () => kept.length === 1 && kept[0].because === 'owner_may_be_alive');
    refused.add('owner_may_be_alive');
    check("the live run's bytes are still there", () => fs.files.get(`${ROOT}/a.part`) === 'live work');
  }

  // --- a host that cannot answer reclaims nothing -----------------------------
  {
    const owner = ownerToken({ pid: 1, startedAt: 1 });
    refuses('a host that cannot report liveness is refused, not guessed at',
      () => isReclaimable({}, owner), 'liveness_unknown');
    refuses('a file with no usable owner is refused', () => isReclaimable({
      processIsRunning: () => false,
    }, { pid: 1 }), 'owner_not_identifiable');
    let tokenRefused = false;
    try { ownerToken({ pid: 1 }); } catch (e) { tokenRefused = e.reason === 'owner_not_identifiable'; }
    check('an owner token without a start time is refused', tokenRefused);

    // Refusing must mean keeping, not silently dropping the entry.
    const fs = mkFs();
    fs.files.set(`${ROOT}/c.part`, 'unknowable');
    const { removed, kept } = sweep(fs, {}, [{ path: `${ROOT}/c.part`, owner }]);
    check('a sweep that cannot decide keeps the file and reports it',
      () => removed.length === 0 && kept[0].because === 'liveness_unknown');
    check('and the file is still there', () => fs.files.has(`${ROOT}/c.part`));
  }

  // --- each threat names a check that ran -------------------------------------
  {
    // The validator used to prove this with a substring search over the file,
    // which a comment satisfies - the same defect as the rule-table scan that
    // its own explanatory comment nearly passed. The suite knows which names it
    // ran, so the comparison is exact and only counts checks that executed.
    const rules = JSON.parse(readFileSync(
      new URL('../schemas/v1/temp-rules.json', import.meta.url), 'utf8'));
    for (const [threat, entry] of Object.entries(rules.threats)) {
      check(`the check named by ${threat} ran`, () => ran.has(entry.testCoverage),
        entry.testCoverage);
    }
  }

  // --- every declared refusal is reachable ------------------------------------
  const unreached = TEMP_REFUSALS.filter((r) => !refused.has(r));
  check('every declared refusal is triggered by a vector',
    unreached.length === 0, `never triggered: ${unreached.join(', ')}`);

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  temporary files: ${TEMP_REFUSALS.length} refusals, ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}
