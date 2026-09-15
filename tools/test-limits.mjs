/**
 * Resource limits, and which vocabulary an overrun gets.
 *
 * #39 asks for the boundary between input_too_large, resource_limit_exceeded
 * and timeout to be settled rather than felt. The vectors are mostly about
 * that: the same overrun must get the same name wherever it happens, and a
 * limit reached must never read as a check that completed (§17.1).
 */
import { readFileSync } from 'node:fs';
import { gzipSync, createGunzip } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import {
  admit, budget, coverageFor, OUTCOMES, LIMIT_REFUSALS, DEFAULT_BUDGETS,
  BASIS_KINDS, budgetsWithoutBasis, LimitExceeded,
} from './limits.mjs';
import {
  measure, measureMemoryInCleanProcess, spread, inputBytesWithin, inputBytesWithinMemory,
} from './measure-budgets.mjs';

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  // Top-level await is used below: a real decompressor is a stream.
  let failures = 0;
  const seen = new Set();
  const refused = new Set();
  const fail = (name, detail) => {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  };
  process.on('uncaughtException', (e) => {
    fail('the suite aborted instead of reporting a failure', e?.stack ?? String(e));
    console.log(`\nFAIL  resource limits: ${failures} failure(s)`);
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    fail('the suite aborted on a rejected promise', e?.stack ?? String(e));
    console.log(`\nFAIL  resource limits: ${failures} failure(s)`);
    process.exit(1);
  });
  const check = (name, cond, detail) => {
    let value;
    try { value = typeof cond === 'function' ? cond() : cond; }
    catch (e) { fail(name, `threw instead of returning: ${e?.outcome ?? e?.reason ?? e?.message ?? e}`); return; }
    if (value) console.log(`ok    ${name}`);
    else fail(name, detail);
  };
  const exceeds = (name, fn, expected) => {
    try { fn(); check(name, false, `expected ${expected}, got success`); }
    catch (e) {
      if (e instanceof LimitExceeded) seen.add(e.outcome); else refused.add(e.reason);
      check(name, e.outcome === expected || e.reason === expected,
        `expected ${expected}, got ${e.outcome ?? e.reason ?? e.message}`);
    }
  };

  // --- the boundary between the three names -----------------------------------
  {
    // Decided before anything opens: nothing was attempted, so it is a skip.
    exceeds('an input larger than the cap is refused before any work',
      () => admit(DEFAULT_BUDGETS.inputBytes + 1), 'input_too_large');
    check('and that is reported as a skip, not a failure',
      () => coverageFor('input_too_large') === 'skipped');
    check('an input at the cap is admitted', () => admit(DEFAULT_BUDGETS.inputBytes) === true);

    // Found while working: something was attempted and abandoned.
    check('an overrun found while working is a failure, not a skip',
      () => coverageFor('resource_limit_exceeded') === 'failed'
        && coverageFor('timeout') === 'failed');

    // §17.1: nothing that stopped may read as a check that completed.
    check('no outcome is reported as completed',
      () => OUTCOMES.every((o) => coverageFor(o) !== 'completed'));

    // The caller does not get to choose which name an overrun wears.
    let relabelled = false;
    try { coverageFor('input_too_large_but_call_it_failed'); }
    catch (e) { relabelled = e.reason === 'budget_exceeded'; refused.add(e.reason); }
    check('an outcome outside the table cannot be asked for', relabelled);
  }

  // --- a real decompression bomb, stopped before it lands ---------------------
  {
    // Not simulated counters: a gzip stream this repository makes, expanded by
    // node's own decompressor, with the budget counting the bytes as they
    // arrive. 64 MB of zeros compresses to about 64 KB - a ratio near 1000:1 -
    // and the point of the vector is that the run stops long before the 64 MB
    // exists anywhere.
    const uncompressedBytes = 64 * 1024 * 1024;
    const bomb = gzipSync(Buffer.alloc(uncompressedBytes, 0));
    check('the bomb really is small and really does expand',
      () => bomb.length < 128 * 1024 && uncompressedBytes / bomb.length > 500,
      `${bomb.length} bytes -> ${uncompressedBytes}`);

    const b = budget({ ...DEFAULT_BUDGETS, expansionRatio: 20, wallClockMs: 60000 });
    b.consume(bomb.length);
    let stoppedAfter = 0;
    let outcome = null;
    const gunzip = createGunzip();
    gunzip.on('data', (chunk) => {
      try {
        stoppedAfter += chunk.length;
        b.produce(chunk.length);
      } catch (e) {
        outcome = e.outcome;
        gunzip.destroy();
      }
    });
    await new Promise((resolve) => {
      gunzip.on('close', resolve);
      gunzip.on('error', resolve);
      gunzip.end(bomb);
    });

    check('a real gzip bomb is stopped', () => outcome === 'resource_limit_exceeded', outcome);
    if (outcome) seen.add(outcome);
    // The AC is "refused before memory is exhausted", so the number that
    // matters is how much arrived before it stopped - not merely that it
    // stopped eventually.
    check('and stopped before the whole expansion materialised',
      () => stoppedAfter < uncompressedBytes / 10,
      `${stoppedAfter} of ${uncompressedBytes} bytes arrived`);
  }

  // --- a decompression bomb is caught by ratio, not by size -------------------
  {
    // A bomb is small. An absolute byte ceiling set high enough to allow a large
    // legitimate file lets it through; the ratio is what sees it.
    const b = budget({ ...DEFAULT_BUDGETS, expansionRatio: 10, wallClockMs: 60000 });
    b.consume(1024);
    b.produce(5 * 1024);
    check('an ordinary expansion passes', () => b.spent().produced === 5 * 1024);
    exceeds('a stream that expands past its ratio is stopped',
      () => b.produce(20 * 1024), 'resource_limit_exceeded');

    const roomy = budget({ ...DEFAULT_BUDGETS, inputBytes: 1 << 30, expansionRatio: 10 });
    roomy.consume(64);
    exceeds('and a small bomb is caught even where the byte ceiling is huge',
      () => roomy.produce(64 * 1024), 'resource_limit_exceeded');
  }

  // --- a cyclic object graph ends ---------------------------------------------
  {
    // A PDF object graph can contain a cycle. Walking it without a bound does
    // not return, and a test that walks a tree would never notice.
    const cyclic = { name: 'root' };
    cyclic.child = { name: 'child', parent: cyclic };

    const b = budget({ ...DEFAULT_BUDGETS, graphDepth: 8 });
    const walk = (node) => {
      const leave = b.enter(node.name);
      try {
        for (const value of Object.values(node)) {
          if (value && typeof value === 'object') walk(value);
        }
      } finally { leave(); }
    };
    exceeds('a cycle is stopped by depth rather than running for ever',
      () => walk(cyclic), 'resource_limit_exceeded');

    // Released on the way out, or a wide graph looks like a deep one.
    const wide = { name: 'root' };
    for (let i = 0; i < 100; i += 1) wide[`child${i}`] = { name: `child${i}` };
    const b2 = budget({ ...DEFAULT_BUDGETS, graphDepth: 8 });
    const walk2 = (node) => {
      const leave = b2.enter(node.name);
      try {
        for (const value of Object.values(node)) {
          if (value && typeof value === 'object') walk2(value);
        }
      } finally { leave(); }
    };
    check('a wide but shallow graph is not mistaken for a deep one',
      () => { walk2(wide); return b2.spent().depth === 0; });
  }

  // --- time is its own answer --------------------------------------------------
  {
    let clock = 0;
    const b = budget({ ...DEFAULT_BUDGETS, wallClockMs: 100 }, { now: () => clock });
    b.consume(1);
    clock = 101;
    // Separate from resource_limit_exceeded because the remedy differs: a bigger
    // machine does not fix a timeout the way it fixes a memory ceiling.
    exceeds('work that runs out of time says so, not that it ran out of room',
      () => b.consume(1), 'timeout');
  }

  // --- an undeclared budget is not an unlimited one ----------------------------
  {
    for (const [label, budgets] of [
      ['nothing at all', {}],
      ['a missing expansion ratio', { ...DEFAULT_BUDGETS, expansionRatio: undefined }],
      ['a missing clock', { ...DEFAULT_BUDGETS, wallClockMs: undefined }],
    ]) {
      let refusedHere = false;
      try { budget(budgets); } catch (e) { refusedHere = e.reason === 'budget_not_declared'; refused.add(e.reason); }
      check(`${label} is refused rather than treated as unlimited`, refusedHere);
    }
    let admitRefused = false;
    try { admit(1, {}); } catch (e) { admitRefused = e.reason === 'budget_not_declared'; }
    check('and admitting against no cap is refused too', admitRefused);
  }

  // --- every default accounts for itself ---------------------------------------
  {
    const without = budgetsWithoutBasis();
    check('every budget default names where it came from', without.length === 0,
      without.join(', '));
    const rules = JSON.parse(readFileSync(
      new URL('../schemas/v1/limit-rules.json', import.meta.url), 'utf8'));
    // A measured basis has to name a measurement this repository produces.
    const produced = Object.keys({ ...measure({ sampleBytes: 1 << 20, samples: 1 }), memory: [] });
    for (const [name, b] of Object.entries(rules.budgets)) {
      if (name === '$comment' || b.basis !== 'measured') continue;
      check(`${name} names a measurement the harness produces`,
        produced.includes(b.measurement), `${b.measurement} not in ${produced.join(', ')}`);
    }
    for (const [name, b] of Object.entries(rules.budgets)) {
      if (name === '$comment') continue;
      check(`${name}'s basis is one of the declared kinds`, BASIS_KINDS.includes(b.basis), b.basis);
      if (b.basis === 'provisional') {
        check(`${name} names who owes the answer`,
          typeof b.owner === 'string' && b.owner.includes('#'), b.owner);
      }
    }
  }

  // --- the measurement is a method, and it runs --------------------------------
  {
    const result = measure({ sampleBytes: 4 * 1024 * 1024, samples: 3 });
    check('the harness reports the machine it ran on',
      () => typeof result.machine === 'string' && result.machine.length > 0);
    check('and produces rates that are not zero',
      () => result.hashBytesPerSecond > 0 && result.readBytesPerSecond > 0);

    // In a child, because arrayBuffers is a process-wide total and this suite
    // has just expanded a 64 MB decompression bomb. Measured here it reads a
    // different multiplier than the same code run on its own, which is the
    // instrument answering a question about the suite rather than about the
    // build.
    const memory = measureMemoryInCleanProcess({ sizes: [8, 32, 128] });
    // The multiplier is structural - one copy of the input plus one more - so
    // it cannot depend on the size of the file. A reading that falls as the
    // sizes grow is the instrument contaminating itself, which is what this
    // measurement did until the buffers were kept alive: 2.00, then 1.50, then
    // 1.50, for a number that does not vary. Reported as a finding it would
    // have been wrong in the direction that makes the limit look safer.
    const band = spread(memory);
    check('the multiplier does not vary with the size of the input',
      () => band.max - band.min < 0.1,
      memory.map((s) => `${s.fileBytes / 1024 / 1024}MB:${s.ratio.toFixed(2)}`).join(' '));
    // The build reads the input whole and copies it into the record, so it
    // holds about twice the file. This is the measured fact the input cap is
    // reasoned against - and the one that changes if #36's copy ever goes.
    check('a run holds more than one copy of the input',
      () => Math.max(...memory.map((s) => s.ratio)) > 1.5,
      memory.map((s) => s.ratio.toFixed(2)).join(', '));

    // What the measurement settled, recorded so the next person does not
    // re-derive it: neither time nor memory forces the input cap on a machine
    // like this one, so the cap is a decision and says so.
    const byTime = inputBytesWithin(result);
    const byMemory = inputBytesWithinMemory(memory, result);
    check('the cap is well below what time and memory allow here',
      () => DEFAULT_BUDGETS.inputBytes < byTime && DEFAULT_BUDGETS.inputBytes < byMemory,
      `cap ${DEFAULT_BUDGETS.inputBytes}, time ${byTime}, memory ${byMemory}`);
  }

  // --- every declared outcome and refusal is reachable --------------------------
  const unseen = OUTCOMES.filter((o) => !seen.has(o));
  check('every declared outcome is produced by a vector', unseen.length === 0,
    `never produced: ${unseen.join(', ')}`);
  const unrefused = LIMIT_REFUSALS.filter((r) => !refused.has(r));
  check('every declared refusal is triggered by a vector', unrefused.length === 0,
    `never triggered: ${unrefused.join(', ')}`);

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  resource limits: ${OUTCOMES.length} outcomes, ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}
