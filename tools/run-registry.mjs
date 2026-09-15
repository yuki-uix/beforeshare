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
const STAGES = RULES.record.stages;

/**
 * A caller's value, as a primitive string, checked before any lock is taken.
 *
 * Anything else reaches JSON.stringify as an object, whose toJSON and getters
 * then run wherever the serialising happens.
 */
function asPlainString(field, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RegistryRefused('not_a_plain_value',
      `${field} must be a non-empty string, not ${typeof value}`);
  }
  return String(value);
}

/** Every field the record contract declares, and nothing else. */
function assertRecordShape(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`a record must be an object, not ${JSON.stringify(record)}`);
  }
  const keys = Object.keys(record).sort();
  const expected = [...RECORD_FIELDS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new Error(`fields are ${keys.join(', ')}, expected ${expected.join(', ')}`);
  }
  for (const field of ['runId', 'inputPath', 'stage']) {
    if (typeof record[field] !== 'string') throw new Error(`${field} is not a string`);
  }
  for (const field of ['pid', 'startedAt']) {
    if (typeof record[field] !== 'number') throw new Error(`${field} is not a number`);
  }
  if (!STAGES.includes(record.stage)) throw new Error(`stage ${record.stage} is not a stage`);
}

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
  } catch (e) {
    // Only "there is no file" means there is no registry. A permissions or I/O
    // failure read as an empty registry is worse than a crash: the next issue()
    // writes a fresh array over a file that still holds every identifier ever
    // given out, and nothing says so.
    if (e?.code !== 'ENOENT') {
      throw new RegistryRefused('registry_unreadable', `${path}: ${e?.code ?? e?.message ?? e}`);
    }
    return [];
  }
  if (raw === undefined || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    // Parsing is not validating. [null] is valid JSON and a valid array, and it
    // reaches the caller as a TypeError from somewhere else entirely. Unknown
    // fields fail here too: a record carrying something nobody reads is a rule
    // nobody enforces, wearing the shape of one that is.
    for (const record of parsed) assertRecordShape(record);
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
      // Copied to primitives BEFORE the lock. JSON.stringify runs a value's own
      // toJSON and getters, so serialising a caller's object inside the lock
      // runs the caller's code there - which is the one thing the lock contract
      // says never happens. Measured: an object whose toJSON looked at the lock
      // file saw it held.
      const id = asPlainString('runId', runId);
      const input = asPlainString('inputPath', inputPath);
      return withLock(fs, lockPath, () => {
        const records = load(fs, path);
        if (records.some((r) => r.runId === id)) {
          throw new RegistryRefused('duplicate_run_id',
            `${id} was issued at ${records.find((r) => r.runId === id).startedAt}`);
        }
        const record = { runId: id, inputPath: input, pid, startedAt, stage: 'inspect' };
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
      const id = asPlainString('runId', runId);
      if (!STAGES.includes(stage)) {
        throw new RegistryRefused('unknown_stage',
          `${JSON.stringify(stage)} is not one of ${STAGES.join(', ')}`);
      }
      return withLock(fs, lockPath, () => {
        const records = load(fs, path);
        const record = records.find((r) => r.runId === id);
        if (record === undefined) {
          throw new RegistryRefused('unknown_run', `${id} was never issued`);
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
