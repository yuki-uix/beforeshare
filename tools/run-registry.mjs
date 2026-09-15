/**
 * Which runs exist, on this machine, across restarts.
 *
 * Three contracts were waiting on this. The identity binding's checks compare
 * against a set of run identifiers the caller supplies, so a caller with the
 * wrong set defeats them (#35). The sweep needs to know whether a temporary
 * file's owner is still alive (#38). Crash recovery needs to know which runs
 * were in flight (#37). All three need the same thing: a record that outlives
 * the process that made it.
 *
 * §14.1 allows bounded local threads or processes and rules out a distributed
 * queue, so this is one machine and one file.
 *
 * A reference implementation of schemas/v1/concurrency-rules.json, not the
 * product runtime. The core language is still undecided.
 */
import { readFileSync } from 'node:fs';
import { ownerToken, isReclaimable } from './temp-files.mjs';

const RULES = JSON.parse(
  readFileSync(new URL('../schemas/v1/concurrency-rules.json', import.meta.url), 'utf8'),
);

export const REGISTRY_REFUSALS = Object.keys(RULES.refusals);
export const RECORD_FIELDS = RULES.record.fields;
export const LOCK_SCOPE = RULES.lock.scope;
export const NEVER_HELD_ACROSS = RULES.lock.neverHeldAcross;

export class RegistryRefused extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
  }
}

/** Registries this module made. A record is only trusted if it came from one. */
const registries = new WeakSet();

/**
 * Do one thing to the registry file, with nobody else doing one at the same time.
 *
 * The lock covers a read, a change and a write, and is released before this
 * returns. Nothing the caller supplies runs inside it: a caller's callback
 * could wait for a person, and §11.1's per-finding review means somebody's
 * runs do exactly that. One open dialog would then stall the machine.
 */
function withLock(fs, lockPath, change) {
  if (!fs.createExclusive(lockPath, { mode: 0o600 })) {
    throw new RegistryRefused('lock_held', lockPath);
  }
  try {
    return change();
  } finally {
    try { fs.unlink(lockPath); } catch { /* a stale lock is reported, not thrown here */ }
  }
}

/**
 * Replace the registry in one step, so a reader never sees half of it.
 *
 * Writing in place leaves an interval in which the file is a truncated JSON
 * document, and a reader arriving then is told the registry is unreadable -
 * which stops a run that had nothing to do with the write. The lock keeps two
 * writers apart; it does nothing about readers, who do not take it.
 */
function replaceAtomically(fs, path, contents) {
  const staging = `${path}.writing`;
  fs.write(staging, contents);
  fs.rename(staging, path);
}

function load(fs, path) {
  let raw;
  try {
    raw = fs.read(path);
  } catch {
    return [];   // no registry yet is not an unreadable one
  }
  if (raw === undefined || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed;
  } catch (e) {
    // Starting fresh here would reissue every identifier the file held, which
    // is the defect the durable registry exists to prevent.
    throw new RegistryRefused('registry_unreadable', `${path}: ${e?.message ?? e}`);
  }
}

/**
 * @param {object} fs    needs read, write, rename, createExclusive(path, {mode}), unlink
 * @param {object} opts  { path, lockPath }
 */
export function openRegistry(fs, { path, lockPath = `${path}.lock` } = {}) {
  const registry = {
    path,

    /** Every record, including runs from before this process started. */
    records() {
      return load(fs, path);
    },

    /**
     * Claim an identifier, or refuse. The lock is held for this and released
     * before the caller sees anything.
     */
    issue(runId, { inputPath, pid = process.pid, startedAt }) {
      // Refused by the same rule that refuses an unidentifiable temporary file
      // owner: a process id alone is recycled.
      ownerToken({ pid, startedAt });
      return withLock(fs, lockPath, () => {
        const records = load(fs, path);
        if (records.some((r) => r.runId === runId)) {
          throw new RegistryRefused('duplicate_run_id',
            `${runId} was issued at ${records.find((r) => r.runId === runId).startedAt}`);
        }
        const record = { runId, inputPath, pid, startedAt, stage: 'inspect' };
        replaceAtomically(fs, path, JSON.stringify([...records, record]));
        return record;
      });
    },

    /** Whether this identifier was ever issued, in this process or a previous one. */
    knows(runId) {
      return load(fs, path).some((r) => r.runId === runId);
    },

    /**
     * Whether the run's process is still there.
     *
     * The host answers; a host that cannot is not guessed for. Identity is pid
     * and start time together, because a recycled process id would otherwise
     * report a dead run as live for ever.
     */
    isLive(host, runId) {
      const record = load(fs, path).find((r) => r.runId === runId);
      if (record === undefined) return false;
      // One implementation of "is that process still there", not two. The
      // temporary-file rules already had to answer it to decide whether a file
      // was an orphan, and a second copy here would be a second thing to keep
      // in step - with the same refusals spelled out twice and free to drift.
      return !isReclaimable(host, ownerToken({ pid: record.pid, startedAt: record.startedAt }));
    },

    /** Move a run on, so a reader can tell inspect from sanitize from verify. */
    advance(runId, stage) {
      return withLock(fs, lockPath, () => {
        const records = load(fs, path);
        const record = records.find((r) => r.runId === runId);
        if (record === undefined) {
          throw new RegistryRefused('unknown_run', `${runId} was never issued`);
        }
        record.stage = stage;
        replaceAtomically(fs, path, JSON.stringify(records));
        return record;
      });
    },
  };
  registries.add(registry);
  return Object.freeze(registry);
}

/** The set the identity checks need, built from the registry rather than by a caller. */
export function knownRunIds(registry) {
  if (!registries.has(registry)) {
    throw new RegistryRefused('not_a_registry',
      'this did not come from openRegistry(), so the identity checks would be comparing against whatever the caller assembled');
  }
  return new Set(registry.records().map((r) => r.runId));
}

export { RULES as CONCURRENCY_RULES };
