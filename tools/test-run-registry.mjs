/**
 * What two runs on one machine may do at once.
 *
 * The case that shapes everything else is #40's third criterion: a lock must
 * not be held across waiting for a person. §11.1 requires per-finding review,
 * so a run stops and waits - and a lock held there turns one open confirmation
 * dialog into a machine-wide stall.
 */
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { createGate } from './path-gate.mjs';
import { intake, confirmUnchanged, approve, checkSanitizeAllowed, hashBytes } from './file-identity.mjs';
import { claimOutputPath, writeClaimed } from './output-naming.mjs';
import { openRegistry, knownRunIds, REGISTRY_REFUSALS, RECORD_FIELDS } from './run-registry.mjs';

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  let failures = 0;
  const refused = new Set();
  const fail = (name, detail) => {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  };
  process.on('uncaughtException', (e) => {
    fail('the suite aborted instead of reporting a failure', e?.stack ?? String(e));
    console.log(`\nFAIL  run registry: ${failures} failure(s)`);
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    fail('the suite aborted on a rejected promise', e?.stack ?? String(e));
    console.log(`\nFAIL  run registry: ${failures} failure(s)`);
    process.exit(1);
  });
  const check = (name, cond, detail) => {
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
  const REG = `${ROOT}/.runs.json`;

  /** One filesystem, shared by every "process" in these vectors. */
  const mkFs = (seed = { [INPUT]: 'original bytes' }) => {
    const files = new Map(Object.entries(seed));
    return {
      files,
      realpath: (p) => p,
      isDirectory: (p) => p === ROOT,
      read: (p) => {
        if (!files.has(p)) { const e = new Error(p); e.code = 'ENOENT'; throw e; }
        return files.get(p);
      },
      write: (p, bytes) => (files.set(p, bytes), true),
      createExclusive: (p, { mode } = {}) => (files.has(p) ? false : (files.set(p, ''), true)),
      link: (from, to) => (files.has(to) ? false : (files.set(to, files.get(from)), true)),
      rename: (from, to) => { files.set(to, files.get(from)); files.delete(from); return true; },
      unlink: (p) => files.delete(p),
    };
  };
  const gateFor = (fs) => createGate({ fs, authorisedRoots: [ROOT] });

  // --- a run waiting for a person does not stop anyone else -------------------
  {
    const fs = mkFs();
    const g = gateFor(fs);
    const registry = openRegistry(fs, { path: REG });

    // The first run reaches the point where a person must read the findings.
    registry.issue('run-a', { inputPath: INPUT, startedAt: 1 });
    const recordA = intake(fs, g.forRead(INPUT), { runId: 'run-a' });
    const confirmedA = confirmUnchanged(fs, recordA, g.forRead(INPUT));
    // ... and stops here. Nobody is looking at the screen.

    // A second run, in another process, must be able to start and finish.
    let second = null;
    try {
      second = registry.issue('run-b', { inputPath: INPUT, startedAt: 2 });
    } catch (e) { second = e; }
    check('a second run can be issued while the first waits for a person',
      () => second?.runId === 'run-b', second?.reason ?? second?.message);
    check('and the registry knows both', () => registry.records().length === 2);

    // The first run's approval is still safe, and not because anything is
    // locked: the input hash is what refuses a stale one.
    const approval = approve(confirmedA, { actions: ['remove_pdf_metadata_field'] });
    check('the waiting run can still be approved',
      () => checkSanitizeAllowed(fs, approval, g.forRead(INPUT),
        { runIds: knownRunIds(registry) }).runId === 'run-a');
    fs.write(INPUT, 'changed while the dialog was open');
    let stale = null;
    try {
      checkSanitizeAllowed(fs, approval, g.forRead(INPUT), { runIds: knownRunIds(registry) });
    } catch (e) { stale = e.reason; }
    check('and a change during the wait still invalidates it, without a lock',
      () => stale === 'input_changed_since_inspection', stale);

    // No lock file survives any of that.
    check('no lock is left behind', () => !fs.files.has(`${REG}.lock`));
  }

  // --- two runs, one input, both finishing ------------------------------------
  {
    // §20.2's concurrent case, end to end and through the registry rather than
    // asserted elsewhere and pointed at. Two runs inspect the same input, both
    // are approved, and both publish. The registry does not arbitrate the
    // output name - #36 does, atomically - so what this asserts is that the two
    // halves compose: distinct destinations, both complete, and the input
    // untouched.
    const fs = mkFs();
    const g = gateFor(fs);
    const registry = openRegistry(fs, { path: REG });
    const before = hashBytes(fs.files.get(INPUT));

    const runs = ['run-p', 'run-q'].map((runId, i) => {
      registry.issue(runId, { inputPath: INPUT, startedAt: i + 1 });
      const record = intake(fs, g.forRead(INPUT), { runId });
      const approval = approve(confirmUnchanged(fs, record, g.forRead(INPUT)),
        { actions: ['remove_pdf_metadata_field'] });
      return { runId, approval, claim: claimOutputPath(fs, g, g.forRead(INPUT)) };
    });

    check('two concurrent runs reserve different names',
      () => runs[0].claim.temp.path !== runs[1].claim.temp.path);

    const published = runs.map(({ approval, claim, runId }) => {
      checkSanitizeAllowed(fs, approval, g.forRead(INPUT), { runIds: knownRunIds(registry) });
      return writeClaimed(fs, g, claim, `sanitized by ${runId}`);
    });

    check('neither run believes it published where the other did',
      () => published[0] !== published[1], published.join(' / '));
    check('both outputs are complete and are their own',
      () => fs.files.get(published[0]) === 'sanitized by run-p'
        && fs.files.get(published[1]) === 'sanitized by run-q');
    check('the input is byte-identical after both',
      () => hashBytes(fs.files.get(INPUT)) === before);
    check('nothing half-written is left behind',
      () => ![...fs.files.keys()].some((k) => k.endsWith('.part')));
    check('the registry knows both runs', () => knownRunIds(registry).size >= 2);
  }

  // --- the set the identity checks use comes from here ------------------------
  {
    const fs = mkFs();
    const registry = openRegistry(fs, { path: REG });
    registry.issue('run-1', { inputPath: INPUT, startedAt: 1 });
    check('known identifiers are read from the registry',
      () => knownRunIds(registry).has('run-1'));
    // The checks in file-identity compare against a set the caller supplies.
    // Taking it from anything shaped like a registry would put the caller back
    // in charge of the set they are being checked against.
    refuses('a hand-built registry cannot supply that set',
      () => knownRunIds({ records: () => [{ runId: 'invented' }] }), 'not_a_registry');
  }

  // --- a restart does not forget ----------------------------------------------
  {
    const fs = mkFs();
    const first = openRegistry(fs, { path: REG });
    first.issue('run-x', { inputPath: INPUT, startedAt: 1 });

    // A new process: a new registry object over the same file.
    const afterRestart = openRegistry(fs, { path: REG });
    check('a run issued before the restart is still known',
      () => afterRestart.knows('run-x'));
    refuses('and its identifier cannot be issued again',
      () => afterRestart.issue('run-x', { inputPath: INPUT, startedAt: 2 }),
      'duplicate_run_id');
    check('the identity checks see it too', () => knownRunIds(afterRestart).has('run-x'));
  }

  // --- a reader never sees half a registry ------------------------------------
  {
    // The lock keeps two writers apart. It does nothing about readers, who do
    // not take it - so a registry written in place has an interval in which the
    // file is a truncated JSON document, and a reader arriving then is told the
    // registry is unreadable. That stops a run with nothing to do with the
    // write. Writing beside it and renaming leaves no such interval.
    const fs = mkFs();
    const registry = openRegistry(fs, { path: REG });
    registry.issue('run-first', { inputPath: INPUT, startedAt: 1 });
    const before = registry.records();

    let seenByReader = null;
    const realWrite = fs.write;
    fs.write = (p, bytes) => {
      const result = realWrite(p, bytes);
      // Another process reads at the worst possible moment: the new contents
      // are on disk somewhere, and the swap has not happened.
      if (p.endsWith('.writing')) {
        try { seenByReader = openRegistry(fs, { path: REG }).records(); }
        catch (e) { seenByReader = e; }
      }
      return result;
    };
    registry.issue('run-second', { inputPath: INPUT, startedAt: 2 });

    check('a reader during the write sees the previous registry, whole',
      () => Array.isArray(seenByReader) && seenByReader.length === before.length,
      seenByReader?.reason ?? JSON.stringify(seenByReader));
    check('and the write still landed', () => registry.records().length === 2);
    check('nothing is left beside the registry',
      () => ![...fs.files.keys()].some((k) => k.endsWith('.writing')));
  }

  // --- an unreadable registry stops the run rather than emptying itself -------
  {
    const fs = mkFs();
    fs.files.set(REG, '{ this is not json');
    const registry = openRegistry(fs, { path: REG });
    // Starting fresh here would reissue every identifier the file held, which
    // is the whole defect a durable registry exists to prevent.
    refuses('an unreadable registry is refused, not replaced',
      () => registry.records(), 'registry_unreadable');
    check('and the file is left alone for someone to look at',
      () => fs.files.get(REG) === '{ this is not json');
  }

  // --- a lock nobody released does not hang the next process ------------------
  {
    const fs = mkFs();
    const registry = openRegistry(fs, { path: REG });
    fs.files.set(`${REG}.lock`, '');   // another process died holding it
    refuses('a held lock is reported, not waited on for ever',
      () => registry.issue('run-y', { inputPath: INPUT, startedAt: 1 }), 'lock_held');
  }

  // --- liveness has one implementation, not two -------------------------------
  {
    const fs = mkFs();
    const registry = openRegistry(fs, { path: REG });
    registry.issue('run-live', { inputPath: INPUT, pid: 10, startedAt: 100 });
    const host = { processIsRunning: (o) => o.pid === 10 && o.startedAt === 100 };
    check('a run whose process is there is live', () => registry.isLive(host, 'run-live'));
    check('a run this registry never issued is not live',
      () => registry.isLive(host, 'run-ghost') === false);
    const otherHost = { processIsRunning: () => false };
    check('a run whose process is gone is not live',
      () => registry.isLive(otherHost, 'run-live') === false);
    // The answer comes from the temporary-file rules, which already had to
    // decide it. Two copies would be two things to keep in step.
    const src = readFileSync(new URL('./run-registry.mjs', import.meta.url), 'utf8');
    check('liveness is not reimplemented here',
      () => src.includes('isReclaimable') && !/processIsRunning\s*\(/.test(src));
  }

  // --- a record holds what survives a restart ---------------------------------
  {
    const fs = mkFs();
    const registry = openRegistry(fs, { path: REG });
    const record = registry.issue('run-fields', { inputPath: INPUT, pid: 7, startedAt: 70 });
    check('a record carries exactly the declared fields',
      () => JSON.stringify(Object.keys(record).sort()) === JSON.stringify([...RECORD_FIELDS].sort()),
      Object.keys(record).join(', '));
    // Nothing that cannot survive being written to a file and read back.
    check('every field survives a round trip through the file',
      () => Object.values(record).every((v) => ['string', 'number'].includes(typeof v)));
    refuses('advancing a run nobody issued is refused',
      () => registry.advance('run-nobody', 'sanitize'), 'unknown_run');
    check('advancing a known run is recorded',
      () => registry.advance('run-fields', 'sanitize').stage === 'sanitize'
        && openRegistry(fs, { path: REG }).records()[0].stage === 'sanitize');
  }

  // --- every declared refusal is reachable ------------------------------------
  const unreached = REGISTRY_REFUSALS.filter((r) => !refused.has(r));
  check('every declared refusal is triggered by a vector',
    unreached.length === 0, `never triggered: ${unreached.join(', ')}`);

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  run registry: ${REGISTRY_REFUSALS.length} refusals, ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}
