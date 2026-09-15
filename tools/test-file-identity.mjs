#!/usr/bin/env node
/**
 * Vectors for stage binding.
 *
 * Every vector calls tools/file-identity.mjs. The last check requires every
 * declared rejection reason to be triggered by some vector: a reason nothing
 * reaches is a rule nobody has shown the binding can enforce.
 */
import { pathToFileURL } from 'node:url';

process.on('uncaughtException', (e) => {
  console.error(`FAIL  the suite aborted instead of reporting a failure\n        ${e?.stack ?? e}`);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error(`FAIL  the suite aborted on a rejected promise\n        ${e?.stack ?? e}`);
  process.exit(1);
});

import { createGate } from './path-gate.mjs';
import {
  intake, bytesOf, approve, confirmUnchanged, contentMatchesHash, releaseRunId,
  checkSanitizeAllowed, checkVerifyAllowed, hashBytes, IDENTITY_REJECTIONS, STAGES,
} from './file-identity.mjs';

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  let failures = 0;
  const triggered = new Set();
  const check = (name, cond, detail) => {
    let value;
    try { value = typeof cond === 'function' ? cond() : cond; }
    catch (e) {
      failures += 1;
      console.error(`FAIL  ${name}\n        threw instead of returning: ${e?.reason ?? e?.message ?? e}`);
      return;
    }
    if (value) console.log(`ok    ${name}`);
    else { failures += 1; console.error(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
  };
  const rejects = (name, fn, expected) => {
    try { fn(); check(name, false, `expected ${expected}, got success`); }
    catch (e) {
      triggered.add(e.reason);
      check(name, e.reason === expected, `expected ${expected}, got ${e.reason ?? e.message}`);
    }
  };

  const ROOT = '/Users/u/Documents';
  const INPUT = `${ROOT}/report.pdf`;

  /** A filesystem whose content can change between reads, and that records them. */
  // Keyed by path: a stub answering every path with the same bytes cannot tell
  // two files apart, so no vector written against it could have caught an
  // approval being honoured for a different file.
  const mkFs = (content, others = {}) => {
    const reads = [];
    const files = new Map([[INPUT, content], ...Object.entries(others)]);
    return {
      reads,
      set(next) { files.set(INPUT, next); },
      setAt(p, next) { files.set(p, next); },
      realpath: (p) => p,
      isDirectory: () => false,
      read(p) {
        reads.push(p);
        if (!files.has(p)) { const e = new Error(`no such file: ${p}`); e.code = 'ENOENT'; throw e; }
        return files.get(p);
      },
      write: () => true,
    };
  };
  const gateFor = (fs) => createGate({ fs, authorisedRoots: [ROOT] });

  // --- the hash covers what the adapters see ----------------------------------
  {
    const fs = mkFs('original');
    const r = intake(fs, gateFor(fs).forRead(INPUT), { runId: 'run-1' });
    check('intake hashes the bytes it captured', r.sha256 === hashBytes('original'));
    check('an adapter reads through the record, not the path', bytesOf(r) === 'original');
    // The ordering claim in inspection-result.schema.json: the hash covers the
    // file before anything else touched it. One read, and the record exists only
    // after it.
    check('intake performs exactly one read', fs.reads.length === 1);
    check('the record names the stage it belongs to', r.stage === STAGES[0]);
  }

  // --- the content behind a record cannot be edited ---------------------------
  // Object.freeze is shallow. A Buffer left on the record could be written
  // through in place, leaving the hash describing bytes nobody could obtain any
  // more — and the vectors, which used strings, would never have seen it. Real
  // reads return Buffers.
  {
    const original = 'original-content';
    const fs = mkFs(Buffer.from(original));
    const r = intake(fs, gateFor(fs).forRead(INPUT), { runId: 'run-buf' });
    check('a Buffer read hashes like its content', r.sha256 === hashBytes(Buffer.from(original)));
    check('the record carries no content field', !('bytes' in r));

    const handed = bytesOf(r);
    Buffer.from(handed.buffer, handed.byteOffset, handed.length).write('EVIL', 0);
    check('writing through the returned bytes does not change the record',
      Buffer.from(bytesOf(r)).toString() === original);
    check('the content still hashes to what the record claims', contentMatchesHash(r));

    check('each call returns a distinct buffer', bytesOf(r) !== bytesOf(r));
  }

  // --- a hand-built record reaches no bytes -----------------------------------
  {
    let forged = false;
    try { bytesOf({ sha256: hashBytes('evil'), bytes: 'evil' }); } catch { forged = true; }
    check('a hand-built record cannot yield bytes', forged);

    const fs = mkFs('original');
    const r = intake(fs, gateFor(fs).forRead(INPUT), { runId: 'run-copy' });
    let copied = false;
    try { bytesOf({ ...r, bytes: 'evil' }); } catch { copied = true; }
    check('a copy of a record is not a record', copied);
  }

  // --- replacement during inspection ------------------------------------------
  {
    const fs = mkFs('original');
    const g = gateFor(fs);
    const r = intake(fs, g.forRead(INPUT), { runId: 'run-confirm' });
    const confirmed = confirmUnchanged(fs, r, g.forRead(INPUT));
    check('an unchanged file confirms',
      () => confirmed.sha256 === r.sha256 && confirmed.runId === r.runId);
    check('a confirmation is a distinct object from the intake record',
      () => confirmed !== r);

    // A file changed and changed back between the two reads hashes the same, so
    // this check answers "is it the same now as when we started", not "was it
    // untouched throughout". Recorded as a vector so the limit is stated rather
    // than assumed.
    const fs3 = mkFs('original');
    const g3 = gateFor(fs3);
    const r3 = intake(fs3, g3.forRead(INPUT), { runId: 'run-3' });
    fs3.set('briefly different');
    fs3.set('original');
    check('a file changed and changed back is not detected, by design',
      () => confirmUnchanged(fs3, r3, g3.forRead(INPUT)).sha256 === r3.sha256);

    const fs2 = mkFs('original');
    const g2 = gateFor(fs2);
    const r2 = intake(fs2, g2.forRead(INPUT), { runId: 'run-2' });
    fs2.set('replaced mid-read');
    rejects('a file replaced during inspection is detected',
      () => confirmUnchanged(fs2, r2, g2.forRead(INPUT)), 'input_replaced_during_inspection');
  }

  // --- an approval is bound to the bytes the user was shown -------------------
  {
    const fs = mkFs('original');
    const g = gateFor(fs);
    const r = intake(fs, g.forRead(INPUT), { runId: 'run-approve' });

    // An intake record proves where it came from, not that the run finished.
    // Approving off one grants sanitize for a file nobody confirmed was still
    // there when the findings were shown.
    rejects('an intake record cannot be approved without a confirmation',
      () => approve(r, { actions: ['remove_pdf_metadata_field'] }), 'stage_out_of_order');

    const approval = approve(confirmUnchanged(fs, r, g.forRead(INPUT)),
      { actions: ['remove_pdf_metadata_field'] });
    const known = { runIds: new Set(['run-approve']) };

    check('an approval for unchanged content is allowed',
      () => checkSanitizeAllowed(fs, approval, g.forRead(INPUT), known).inputSha256 === r.sha256);

    fs.set('edited after approval');
    rejects('an approval does not survive a change to the input',
      () => checkSanitizeAllowed(fs, approval, g.forRead(INPUT), known),
      'input_changed_since_inspection');

    fs.set('original');
    rejects('an approval from a run this process did not issue is refused',
      () => checkSanitizeAllowed(fs, approval, g.forRead(INPUT), { runIds: new Set(['other-run']) }),
      'unknown_run');

    let forged = false;
    try {
      checkSanitizeAllowed(fs, { runId: 'run-approve', inputSha256: r.sha256, actions: [] }, g.forRead(INPUT), known);
    } catch (e) { forged = /did not come from approve/.test(e.message); }
    check('a hand-built approval is refused', forged);

    let noActions = false;
    try {
      approve(confirmUnchanged(fs, r, g.forRead(INPUT)), { actions: [] });
    } catch { noActions = true; }
    check('an approval must name the actions it covers', noActions);
  }

  // --- the adapter's own reference cannot reach into the record ----------------
  {
    // readFile hands back whatever the adapter returned. An adapter that keeps
    // that reference and writes through it after intake would leave the record
    // hashing bytes nobody can still obtain. The earlier vectors only mutated
    // the copy bytesOf returns, which cannot see this.
    const held = Buffer.from('original bytes');
    const fsHolding = {
      realpath: (p) => p, isDirectory: () => false, read: () => held, write: () => true,
    };
    const r = intake(fsHolding, gateFor(fsHolding).forRead(INPUT), { runId: 'run-alias' });
    held.write('EVIL', 0);
    check('the adapter writing through its own reference does not change the record',
      () => contentMatchesHash(r));
    check('bytes taken from the record are the ones it hashed',
      () => bytesOf(r).toString() === 'original bytes');
  }

  // --- a re-read compares the file the record is for ---------------------------
  {
    const fs = mkFs('original');
    const g = gateFor(fs);
    const r = intake(fs, g.forRead(INPUT), { runId: 'run-path' });
    const twin = `${ROOT}/twin.pdf`;
    const fsTwins = mkFs('identical bytes', { [twin]: 'identical bytes' });
    const gTwins = gateFor(fsTwins);
    const rTwin = intake(fsTwins, gTwins.forRead(INPUT), { runId: 'run-twin' });
    const approvalForInput = approve(
      confirmUnchanged(fsTwins, rTwin, gTwins.forRead(INPUT)),
      { actions: ['remove_pdf_metadata_field'] });
    // The hashes agree, so every content check passes. Sanitize writes, so
    // honouring this would rewrite a file nobody approved.
    rejects('an approval does not authorise sanitizing an identical other file',
      () => checkSanitizeAllowed(fsTwins, approvalForInput, gTwins.forRead(twin),
        { runIds: new Set(['run-twin']) }),
      'not_the_path_inspected');

    rejects('confirming against a different path is refused',
      () => confirmUnchanged(fs, r, g.forRead('/Users/u/Documents/other.pdf')),
      'not_the_path_inspected');
  }

  // --- a run identifier names exactly one inspection ---------------------------
  {
    const fs = mkFs('original');
    const g = gateFor(fs);
    intake(fs, g.forRead(INPUT), { runId: 'run-unique' });

    // unknown_run covers identifiers never issued. It says nothing about one
    // issued twice - and a reused id is the case where a second inspection
    // silently inherits the first one's approvals, because every check it faces
    // compares the id and finds a match.
    rejects('a run identifier already in use is refused',
      () => intake(fs, g.forRead(INPUT), { runId: 'run-unique' }), 'duplicate_run_id');

    const other = mkFs('something else');
    rejects('reuse is refused even for a different file',
      () => intake(other, gateFor(other).forRead(INPUT), { runId: 'run-unique' }),
      'duplicate_run_id');

    check('releasing an identifier is reported',
      () => releaseRunId('run-unique') === true && releaseRunId('run-unique') === false);
    // Reissuing it would let an approval outlive the run that earned it: the old
    // approval keeps its brand, and run id, path and hash all still match.
    rejects('a released identifier is still refused',
      () => intake(fs, g.forRead(INPUT), { runId: 'run-unique' }), 'duplicate_run_id');
  }

  // --- verification is handed the file this run produced -----------------------
  {
    const known = { runIds: new Set(['run-1']) };
    const inputSha256 = hashBytes('original');
    const outputSha256 = hashBytes('sanitized');
    const produced = new Map([['run-1', { inputSha256, outputSha256 }]]);

    check('verifying the run\'s own output is allowed',
      () => checkVerifyAllowed({ runId: 'run-1', inputSha256, outputSha256 }, produced, known) === true);

    rejects('verifying a file this run did not produce is refused',
      () => checkVerifyAllowed({ runId: 'run-1', inputSha256, outputSha256: hashBytes('someone else') }, produced, known),
      'output_not_from_this_run');

    rejects('verifying against a different input is refused',
      () => checkVerifyAllowed({ runId: 'run-1', inputSha256: hashBytes('different'), outputSha256 }, produced, known),
      'input_changed_since_inspection');

    rejects('verifying before sanitize recorded an output is refused',
      () => checkVerifyAllowed({ runId: 'run-1', inputSha256, outputSha256 }, new Map(), known),
      'stage_out_of_order');

    rejects('verifying a run this process did not issue is refused',
      () => checkVerifyAllowed({ runId: 'ghost', inputSha256, outputSha256 }, produced, { runIds: new Set() }),
      'unknown_run');
  }

  // --- every declared rejection reason is reachable ---------------------------
  const unreached = IDENTITY_REJECTIONS.filter((r) => !triggered.has(r));
  check('every declared rejection reason is triggered by a vector', unreached.length === 0,
    `never triggered: ${unreached.join(', ')}`);

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  file identity: ${IDENTITY_REJECTIONS.length} reasons, ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}
