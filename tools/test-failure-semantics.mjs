/**
 * What an interruption leaves behind, at every point it can happen.
 *
 * #37 asks for crash injection across the stages of the write rather than at
 * the beginning and the end, so the points come from failure-rules.json and the
 * suite asserts that each one was actually interrupted. A point nothing reaches
 * is a stage nobody is testing while the list still reads as coverage.
 */
import { pathToFileURL } from 'node:url';
import { createGate } from './path-gate.mjs';
import { hashBytes } from './file-identity.mjs';
import { claimOutputPath, writeClaimed } from './output-naming.mjs';
import {
  INTERRUPTION_POINTS, CANCELLATION_CHECKPOINTS, FAILURE_CODES,
  cancellation, classify, isIncomplete, WriteFailed,
} from './failure-semantics.mjs';

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  let failures = 0;
  const interrupted = new Set();
  const produced = new Set();
  const fail = (name, detail) => {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  };
  process.on('uncaughtException', (e) => {
    fail('the suite aborted instead of reporting a failure', e?.stack ?? String(e));
    console.log(`\nFAIL  failure semantics: ${failures} failure(s)`);
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    fail('the suite aborted on a rejected promise', e?.stack ?? String(e));
    console.log(`\nFAIL  failure semantics: ${failures} failure(s)`);
    process.exit(1);
  });
  const check = (name, cond, detail) => {
    let value;
    try { value = typeof cond === 'function' ? cond() : cond; }
    catch (e) { fail(name, `threw instead of returning: ${e?.reason ?? e?.message ?? e}`); return; }
    if (value) console.log(`ok    ${name}`);
    else fail(name, detail);
  };

  const ROOT = '/Users/u/Documents';
  const INPUT = `${ROOT}/report.pdf`;
  const ORIGINAL = 'the original bytes, which nothing may change';
  const DEST = `${ROOT}/report (sanitized).pdf`;

  /**
   * A filesystem that can be made to fail, or to die, at a named point.
   *
   * `dieAt` models a crash: the operation's effect on disk is whatever had
   * happened when the power went, so a partial write leaves partial bytes.
   */
  const mkFs = ({ failWrite, failLink, dieAt, partial } = {}) => {
    const files = new Map([[INPUT, ORIGINAL]]);
    const boom = (code) => { const e = new Error(code); e.code = code; throw e; };
    return {
      files,
      realpath: (p) => p,
      isDirectory: (p) => p === ROOT,
      read: (p) => files.get(p),
      write: (p, bytes) => {
        if (dieAt === 'during_write') {
          // The bytes that made it are on disk; the process is gone.
          files.set(p, String(bytes).slice(0, partial ?? 4));
          const e = new Error('process died mid-write'); e.code = 'CRASH'; throw e;
        }
        if (failWrite) boom(failWrite);
        files.set(p, bytes);
        return true;
      },
      createExclusive: (p) => (files.has(p) ? false : (files.set(p, ''), true)),
      link: (from, to) => {
        if (failLink) boom(failLink);
        if (files.has(to)) return false;
        files.set(to, files.get(from));
        if (dieAt === 'after_publish') {
          const e = new Error('process died after publishing'); e.code = 'CRASH'; throw e;
        }
        return true;
      },
      unlink: (p) => files.delete(p),
    };
  };
  const gateFor = (fs) => createGate({ fs, authorisedRoots: [ROOT] });

  /** The three things that must hold however the run ended. */
  const assertInvariants = (label, fs) => {
    check(`${label}: the original is byte-identical`,
      () => hashBytes(fs.files.get(INPUT)) === hashBytes(ORIGINAL));
    const atDestination = fs.files.get(DEST);
    check(`${label}: the destination is absent or complete`,
      () => atDestination === undefined || atDestination === 'the sanitized bytes',
      `found ${JSON.stringify(atDestination)}`);
    const leftovers = [...fs.files.keys()].filter((k) => k !== INPUT && k !== DEST);
    check(`${label}: anything left behind is marked incomplete`,
      () => leftovers.every((k) => isIncomplete(k)), leftovers.join(', '));
  };

  // --- an interruption at every declared point --------------------------------
  {
    // after_reserve: the cancel is seen before a byte is written.
    {
      const fs = mkFs();
      const g = gateFor(fs);
      const claim = claimOutputPath(fs, g, g.forRead(INPUT));
      const c = cancellation();
      c.cancel();
      let code = null;
      try { writeClaimed(fs, g, claim, 'the sanitized bytes', { cancellation: c }); }
      catch (e) { code = e.code; }
      interrupted.add('after_reserve');
      produced.add(code);
      check('after_reserve: the run stops and says it was cancelled', () => code === 'cancelled');
      assertInvariants('after_reserve', fs);
    }

    // during_write: the process dies with some bytes on disk.
    {
      const fs = mkFs({ dieAt: 'during_write' });
      const g = gateFor(fs);
      const claim = claimOutputPath(fs, g, g.forRead(INPUT));
      let code = null;
      try { writeClaimed(fs, g, claim, 'the sanitized bytes'); }
      catch (e) { code = e.code; }
      interrupted.add('during_write');
      produced.add(code);
      check('during_write: an unclassified failure is not folded into another',
        () => code === 'write_failed');
      assertInvariants('during_write', fs);
    }

    // after_write: the temporary file is complete, nothing is published.
    {
      const fs = mkFs();
      const g = gateFor(fs);
      const claim = claimOutputPath(fs, g, g.forRead(INPUT));
      const c = cancellation();
      let code = null;
      const original = fs.write;
      fs.write = (p, b) => { const r = original(p, b); c.cancel(); return r; };
      try { writeClaimed(fs, g, claim, 'the sanitized bytes', { cancellation: c }); }
      catch (e) { code = e.code; }
      interrupted.add('after_write');
      produced.add(code);
      check('after_write: a cancel between the write and the publish is honoured',
        () => code === 'cancelled');
      assertInvariants('after_write', fs);
    }

    // after_publish: the destination exists and holds every byte.
    {
      const fs = mkFs({ dieAt: 'after_publish' });
      const g = gateFor(fs);
      const claim = claimOutputPath(fs, g, g.forRead(INPUT));
      try { writeClaimed(fs, g, claim, 'the sanitized bytes'); } catch { /* the crash */ }
      interrupted.add('after_publish');
      check('after_publish: the destination holds the whole result',
        () => fs.files.get(DEST) === 'the sanitized bytes');
      // The temporary file outliving the publish is untidy, not incomplete
      // work: the result is already there and whole.
      assertInvariants('after_publish', fs);
    }

    const missed = INTERRUPTION_POINTS.filter((p) => !interrupted.has(p));
    check('every declared interruption point was actually interrupted',
      missed.length === 0, `never interrupted: ${missed.join(', ')}`);
  }

  // --- the filesystem's refusals keep their diagnosis -------------------------
  {
    for (const [errno, expected] of [['ENOSPC', 'disk_full'], ['EDQUOT', 'disk_full'],
      ['EACCES', 'permission_denied'], ['EPERM', 'permission_denied'],
      ['EROFS', 'permission_denied'], ['EIO', 'write_failed']]) {
      const fs = mkFs({ failWrite: errno });
      const g = gateFor(fs);
      const claim = claimOutputPath(fs, g, g.forRead(INPUT));
      let code = null;
      try { writeClaimed(fs, g, claim, 'the sanitized bytes'); } catch (e) { code = e.code; }
      produced.add(code);
      check(`${errno} is reported as ${expected}`, () => code === expected, `got ${code}`);
      assertInvariants(errno, fs);
    }
    // Out of space and no permission need different answers: telling someone to
    // free space when they need access sends them the wrong way.
    check('running out of space is not the same diagnosis as being refused',
      () => classify({ code: 'ENOSPC' }) !== classify({ code: 'EACCES' }));

    // A failure at the publish is a failure, not a quiet fallback to the next
    // name: the next name would be a different file than the one reported.
    const fs = mkFs({ failLink: 'ENOSPC' });
    const g = gateFor(fs);
    const claim = claimOutputPath(fs, g, g.forRead(INPUT));
    let code = null;
    try { writeClaimed(fs, g, claim, 'the sanitized bytes'); } catch (e) { code = e.code; }
    check('a refusal at the publish is reported, not stepped over',
      () => code === 'disk_full');
    assertInvariants('publish refused', fs);
  }

  // --- a failed attempt does not block the name it was using ------------------
  {
    // §6.3 allows debris that is clearly marked incomplete, so the invariants
    // above accept a surviving .part. But #36 handed this issue the case where
    // it accumulates: the reservation is a name, and one left behind by every
    // failed attempt makes that destination unreachable for good. Cleaning up
    // is therefore required here, and required means tested.
    const fs = mkFs({ failWrite: 'ENOSPC' });
    const g = gateFor(fs);
    const first = claimOutputPath(fs, g, g.forRead(INPUT));
    const reserved = first.temp.path;
    try { writeClaimed(fs, g, first, 'the sanitized bytes'); } catch { /* expected */ }
    check('a failed attempt releases the name it reserved', () => !fs.files.has(reserved));

    // A cancellation is raised outside the block that catches filesystem
    // errors, so releasing the name beside each throw missed it entirely and
    // every cancelled run consumed a destination for good.
    const cancelFs = mkFs();
    const cg = gateFor(cancelFs);
    const cancelled = claimOutputPath(cancelFs, cg, cg.forRead(INPUT));
    const cancelledName = cancelled.temp.path;
    const c2 = cancellation();
    c2.cancel();
    try { writeClaimed(cancelFs, cg, cancelled, 'the sanitized bytes', { cancellation: c2 }); }
    catch { /* expected */ }
    check('a cancelled attempt releases the name it reserved too',
      () => !cancelFs.files.has(cancelledName));
    check('and the next run is not pushed onto the following candidate',
      () => claimOutputPath(cancelFs, cg, cg.forRead(INPUT)).temp.path === cancelledName);

    // The proof that it was released is that the next attempt gets it back,
    // rather than being pushed onto the following candidate.
    fs.write = (p, b) => (fs.files.set(p, b), true);
    const second = claimOutputPath(fs, g, g.forRead(INPUT));
    check('the next attempt reaches the same destination',
      () => second.temp.path === reserved);
    check('and publishes there', () => writeClaimed(fs, g, second, 'the sanitized bytes') === DEST);
  }

  // --- a failure never reads as a success -------------------------------------
  {
    const fs = mkFs({ failWrite: 'ENOSPC' });
    const g = gateFor(fs);
    const claim = claimOutputPath(fs, g, g.forRead(INPUT));
    let returned = 'a path, which would mean it worked';
    try { returned = writeClaimed(fs, g, claim, 'the sanitized bytes'); }
    catch (e) { returned = e; }
    check('the failure arrives as an error, not as a path',
      () => returned instanceof WriteFailed);
    check('the error carries a code from the table',
      () => FAILURE_CODES.includes(returned.code), returned.code);
  }

  // --- cancellation latency is measured, not assumed --------------------------
  {
    // §17.4 reports cancellation latency. A flag the caller reads records
    // neither when it was asked for nor when the work stopped.
    let clock = 0;
    const c = cancellation({ now: () => clock });
    check('a run that was never cancelled reports no latency', () => c.latencyMs === null);
    c.cancel();
    clock = 40;
    check('a cancel that is never noticed reports no latency, not zero',
      () => c.latencyMs === null);
    try { c.throwIfCancelled('after_write'); } catch { /* expected */ }
    check('the latency is the distance between asking and stopping',
      () => c.latencyMs === 40, `${c.latencyMs}`);
    clock = 90;
    try { c.throwIfCancelled('after_write'); } catch { /* expected */ }
    check('a later check does not restate the latency',
      () => c.latencyMs === 40, `${c.latencyMs}`);
  }

  // --- the checkpoints are where the table says --------------------------------
  {
    const seen = [];
    const fs = mkFs();
    const g = gateFor(fs);
    const claim = claimOutputPath(fs, g, g.forRead(INPUT));
    const spy = { throwIfCancelled: (p) => { seen.push(p); } };
    writeClaimed(fs, g, claim, 'the sanitized bytes', { cancellation: spy });
    // during_publish only runs when a candidate is refused, so a clean run
    // reaches the first two. The declared list is checked against the source by
    // the validator; this is about the order the run actually asks in.
    check('the run asks before writing and before publishing',
      () => seen[0] === 'after_reserve' && seen[1] === 'after_write', seen.join(' -> '));
    check('every point it asked at is a declared checkpoint',
      () => seen.every((p) => CANCELLATION_CHECKPOINTS.includes(p)), seen.join(', '));
  }

  // --- every declared code was produced by a vector ----------------------------
  const unproduced = FAILURE_CODES.filter((c) => !produced.has(c));
  check('every declared failure code is produced by a vector',
    unproduced.length === 0, `never produced: ${unproduced.join(', ')}`);

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  failure semantics: ${INTERRUPTION_POINTS.length} interruption points, ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}
