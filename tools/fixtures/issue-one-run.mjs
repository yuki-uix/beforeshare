/**
 * One child process, issuing one run into a registry on disk.
 *
 * Exists so the concurrency vectors can involve two real processes contending
 * for one file. Everything else in that suite runs sequentially against an
 * in-memory map, where a lock that covered too little would still pass.
 *
 * Usage: node issue-one-run.mjs <registryPath> <runId> <startAtMs>
 * Prints one line: "ok <runId>" or "refused <reason>".
 */
import {
  readFileSync, writeFileSync, openSync, closeSync, renameSync, unlinkSync,
} from 'node:fs';
import { openRegistry } from '../run-registry.mjs';

const [path, runId, startAt] = process.argv.slice(2);

const fs = {
  read: (p) => readFileSync(p, 'utf8'),
  write: (p, bytes) => (writeFileSync(p, bytes), true),
  rename: (from, to) => (renameSync(from, to), true),
  createExclusive: (p, { mode } = {}) => {
    try { closeSync(openSync(p, 'wx', mode)); return true; } catch { return false; }
  },
  unlink: (p) => { try { unlinkSync(p); return true; } catch { return false; } },
};

// Both children wait for the same wall-clock moment, so they collide rather
// than politely following one another.
const until = Number(startAt);
while (Date.now() < until) { /* spin: a sleep would land them milliseconds apart */ }

const registry = openRegistry(fs, { path });
// Losing the lock race is the expected outcome for one of these, and is not
// the failure the vector is looking for - so it retries. With a pause: fifty
// immediate attempts finish in microseconds and can all land inside the other
// process's critical section, which is how this first failed under load while
// passing on its own. The budget is a deadline, not an attempt count, because
// what matters is how long the other side may reasonably hold the lock.
const deadline = Date.now() + 5000;
let lastReason = 'never attempted';
while (Date.now() < deadline) {
  try {
    const record = registry.issue(runId, { inputPath: '/input', startedAt: Number(startAt) });
    process.stdout.write(`ok ${record.runId}\n`);
    process.exit(0);
  } catch (e) {
    lastReason = e?.reason ?? e?.message;
    if (lastReason !== 'lock_held') {
      process.stdout.write(`refused ${lastReason}\n`);
      process.exit(1);
    }
    const until = Date.now() + 5;
    while (Date.now() < until) { /* a short wait, so the holder can finish */ }
  }
}
process.stdout.write(`refused ${lastReason}_until_deadline\n`);
process.exit(1);
