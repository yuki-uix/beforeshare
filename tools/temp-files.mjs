/**
 * The temporary file's permissions, place, and end.
 *
 * §15 lists "another local user reading temporary artifacts" as a threat and
 * asks for likelihood, impact, mitigation, residual risk and test coverage for
 * each one. The table carries those; this carries the behaviour.
 *
 * A reference implementation of schemas/v1/temp-rules.json, not the product
 * runtime. The core language is still undecided.
 */
import { readFileSync } from 'node:fs';

const RULES = JSON.parse(
  readFileSync(new URL('../schemas/v1/temp-rules.json', import.meta.url), 'utf8'),
);

/** Owner-only, as a number the filesystem call can take. */
export const TEMP_MODE = parseInt(RULES.mode.octal, 8);
export const THREATS = Object.keys(RULES.threats);
export const TEMP_REFUSALS = Object.keys(RULES.refusals).filter((k) => k !== '$comment');
export const TEMP_LOCATION = RULES.location.policy;
export const TEMP_HOLDS = RULES.content.holds;
export const TEMP_NEVER_HOLDS = RULES.content.neverHolds;
export const MODE_SET_AT_CREATION = RULES.mode.setAtCreation;
export const RECLAMATION_NEEDS_PROOF = RULES.reclamation.requiresProofOwnerIsGone;

export class TempRefused extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
  }
}

/**
 * Who owns a temporary file, in a form a later sweep can check.
 *
 * The process id alone is not enough: ids are recycled, and a new process
 * wearing a dead one's number would look alive and keep an orphan forever - or,
 * worse, a dead owner's id reassigned to a live process would make a live
 * file look reclaimable. The start time distinguishes them.
 */
export function ownerToken({ pid = process.pid, startedAt } = {}) {
  if (typeof startedAt !== 'number') {
    throw new TempRefused('owner_not_identifiable',
      'an owner token needs the process start time; a process id alone is recycled');
  }
  return Object.freeze({ pid, startedAt });
}

/**
 * Whether a sweep may delete this temporary file.
 *
 * The host answers whether the owning process is still running. A host that
 * cannot answer gets no reclamation: guessing here deletes work in progress,
 * which turns a cleanup into the loss it exists to prevent.
 */
export function isReclaimable(host, owner) {
  if (!owner || typeof owner.pid !== 'number' || typeof owner.startedAt !== 'number') {
    throw new TempRefused('owner_not_identifiable', 'this file records no usable owner');
  }
  if (typeof host?.processIsRunning !== 'function') {
    throw new TempRefused('liveness_unknown',
      'this host cannot say whether a process is running, so nothing may be reclaimed');
  }
  return host.processIsRunning(owner) === false;
}

/**
 * Reclaim orphans, and never a file whose owner might still be there.
 *
 * Returns what it removed and what it left, because a sweep that only reports
 * successes reads as though it had considered everything.
 */
export function sweep(fs, host, entries) {
  const removed = [];
  const kept = [];
  for (const { path, owner } of entries) {
    let reclaimable = false;
    try {
      reclaimable = isReclaimable(host, owner);
    } catch (e) {
      kept.push({ path, because: e.reason });
      continue;
    }
    if (!reclaimable) { kept.push({ path, because: 'owner_may_be_alive' }); continue; }
    fs.unlink(path);
    removed.push(path);
  }
  return { removed, kept };
}

/**
 * The temporary files in a directory, found by the marker rather than supplied.
 *
 * A sweep handed its list by the caller protects whatever the caller remembered
 * to include - the same shape as a run registry the caller fills in, and the
 * same failure. Discovery belongs here; which of these are orphans still needs
 * an owner for each, which this build cannot read back from a file and which
 * the run registry owes (#40).
 */
export function findTemporaryFiles(fs, directory) {
  if (typeof fs.list !== 'function') {
    throw new TempRefused('cannot_enumerate',
      'this host cannot list a directory, so a sweep would only see what it was handed');
  }
  return fs.list(directory).filter((name) => name.endsWith(RULES.incompleteMarker ?? '.part'))
    .map((name) => `${directory}/${name}`);
}

/** Whether a mode grants anyone but the owner. */
export function readableByOthers(mode) {
  return (mode & 0o077) !== 0;
}

export { RULES as TEMP_RULES };
