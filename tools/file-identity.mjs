/**
 * Reference implementation of stage binding (§14.1, §17.3).
 *
 * §14.1 requires file hashes to bind inspection, remediation and verification,
 * and a changed input to invalidate an earlier approval. The hash is what makes
 * "the same file" checkable across three stages that each reopen it.
 *
 * As with the path gate, the property worth keeping is mechanical rather than
 * procedural: an adapter cannot obtain bytes without an IntakeRecord, and a
 * record only exists after the bytes were hashed. "Hash before reading" is not a
 * rule anyone has to remember.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from './path-gate.mjs';

const RULES = JSON.parse(
  readFileSync(new URL('../schemas/v1/identity-rules.json', import.meta.url), 'utf8'),
);

export const STAGES = RULES.stages;
export const IDENTITY_REJECTIONS = Object.keys(RULES.rejectionReasons);

const intakeRecords = new WeakSet();
const approvals = new WeakSet();
/** Content kept off the record, so freezing the record actually protects it. */
const contents = new WeakMap();

export class IdentityRejected extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
    this.detail = detail;
    if (!IDENTITY_REJECTIONS.includes(reason)) {
      throw new Error(`unlisted identity rejection: ${reason}`);
    }
  }
}

export function hashBytes(bytes) {
  return createHash(RULES.hash.algorithm).update(bytes).digest('hex');
}

/**
 * Read the file and hash it, in that order, once.
 *
 * The bytes are captured here rather than handed back as a path so that the hash
 * and the content an adapter sees are the same read. Handing back a path would
 * let the file change between the hash and the adapter's own open — the window
 * the path gate closes for authorisation, reopened for identity.
 */
export function intake(fs, resolvedPath, { runId }) {
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error('intake requires a run identifier');
  }
  const bytes = readFile(fs, resolvedPath);
  const record = {
    runId,
    path: resolvedPath.path,
    sha256: hashBytes(bytes),
    // Held privately. Object.freeze is shallow, so a Buffer left on the record
    // could be written through in place: the hash would still describe the bytes
    // that were read, and bytesOf would return something else. Strings hid this
    // — real reads return Buffers.
    stage: 'inspect',
  };
  Object.freeze(record);
  intakeRecords.add(record);
  contents.set(record, bytes);
  return record;
}

function assertRecord(record) {
  if (!record || typeof record !== 'object' || !intakeRecords.has(record)) {
    throw new Error('this record did not come from intake');
  }
  return record;
}

/**
 * Bytes are reachable only through a record, and a record has already hashed
 * them.
 *
 * A copy is returned, not the stored buffer: handing back the buffer lets a
 * caller write through it, after which the record's hash describes bytes nobody
 * can obtain any more. The guarantee this module exists for is that the hash
 * covers what an adapter sees.
 */
export function bytesOf(record) {
  assertRecord(record);
  const bytes = contents.get(record);
  if (typeof bytes === 'string') return bytes;
  return Uint8Array.prototype.slice.call(bytes);
}

/** Whether the stored content still hashes to what the record claims. */
export function contentMatchesHash(record) {
  assertRecord(record);
  return hashBytes(contents.get(record)) === record.sha256;
}

/**
 * Re-read at the end of inspection and compare.
 *
 * One hash taken at the start cannot distinguish a stable file from one replaced
 * halfway through: both produce the same opening hash. §20.1 requires a test for
 * files changing during inspection, which means the change has to be detectable.
 */
export function confirmUnchanged(fs, record, resolvedPath) {
  assertRecord(record);
  const after = hashBytes(readFile(fs, resolvedPath));
  if (after !== record.sha256) {
    throw new IdentityRejected('input_replaced_during_inspection',
      `${record.sha256.slice(0, 12)} -> ${after.slice(0, 12)}`);
  }
  return record;
}

/**
 * What the user agreed to, bound to the bytes they were shown.
 *
 * The approval carries the hash rather than the path, because the path is what
 * stays the same when the content changes.
 */
export function approve(record, { actions }) {
  assertRecord(record);
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error('an approval must name the actions it covers');
  }
  const approval = Object.freeze({
    runId: record.runId,
    inputSha256: record.sha256,
    actions: Object.freeze([...actions]),
    grantedFor: 'sanitize',
  });
  approvals.add(approval);
  return approval;
}

function assertApproval(approval) {
  if (!approval || typeof approval !== 'object' || !approvals.has(approval)) {
    throw new Error('this approval did not come from approve()');
  }
  return approval;
}

/**
 * Check an approval against the file as it is now.
 *
 * @param {object} fs
 * @param {object} approval
 * @param {object} resolvedPath  the input, re-resolved for this stage
 * @param {object} known         { runIds: Set<string> } the runs this process issued
 */
export function checkSanitizeAllowed(fs, approval, resolvedPath, known) {
  assertApproval(approval);
  if (!known.runIds.has(approval.runId)) {
    throw new IdentityRejected('unknown_run',
      `${approval.runId} was not issued by this process; inspect again before sanitizing`);
  }
  const now = hashBytes(readFile(fs, resolvedPath));
  if (now !== approval.inputSha256) {
    throw new IdentityRejected('input_changed_since_inspection',
      `approved ${approval.inputSha256.slice(0, 12)}, file is now ${now.slice(0, 12)}`);
  }
  return { runId: approval.runId, inputSha256: now, actions: approval.actions };
}

/** Verification must be handed the file this run produced. */
export function checkVerifyAllowed(fs, { runId, inputSha256, outputSha256 }, produced, known) {
  if (!known.runIds.has(runId)) {
    throw new IdentityRejected('unknown_run', `${runId} was not issued by this process`);
  }
  const record = produced.get(runId);
  if (record === undefined) {
    throw new IdentityRejected('stage_out_of_order',
      `verify was asked for ${runId} before sanitize recorded an output`);
  }
  if (record.inputSha256 !== inputSha256) {
    throw new IdentityRejected('input_changed_since_inspection',
      `run ${runId} sanitized ${record.inputSha256.slice(0, 12)}, not ${inputSha256.slice(0, 12)}`);
  }
  if (record.outputSha256 !== outputSha256) {
    throw new IdentityRejected('output_not_from_this_run',
      `run ${runId} produced ${record.outputSha256.slice(0, 12)}, not ${outputSha256.slice(0, 12)}`);
  }
  return true;
}

export { readFile, writeFile };
