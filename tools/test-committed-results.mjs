// Exercise the Git guard in an isolated repository. The fake cargo only
// regenerates a deterministic result; parser correctness has separate tests.
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const dir = mkdtempSync(join(tmpdir(), 'beforeshare-committed-'));
try {
  for (const path of ['tools', 'bin', 'fixtures/pdf/results']) mkdirSync(join(dir, path), { recursive: true });
  copyFileSync(new URL('./regenerate-results.sh', import.meta.url), join(dir, 'tools/regenerate-results.sh'));
  const cargo = join(dir, 'bin/cargo');
  writeFileSync(cargo, '#!/bin/sh\nprintf "{}\\n" > fixtures/pdf/results/example.json\n');
  chmodSync(cargo, 0o700);
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Test fixture');
  git('commit', '-q', '--allow-empty', '-m', 'fixture baseline');
  const run = () => spawnSync('bash', ['tools/regenerate-results.sh'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
  });
  const untracked = run();
  assert.equal(untracked.status, 1);
  assert.match(untracked.stderr, /committed results differ/);
  console.log('ok    regenerated but untracked output is rejected');
  git('add', 'fixtures/pdf/results/example.json');
  const staged = run();
  assert.equal(staged.status, 1);
  console.log('ok    staged but uncommitted output is rejected');
  git('commit', '-q', '-m', 'commit expected output');
  assert.equal(run().status, 0);
  console.log('ok    committed identical output passes');
  writeFileSync(join(dir, 'fixtures/pdf/results/example.json'), '{"stale":true}\n');
  git('add', 'fixtures/pdf/results/example.json');
  git('commit', '-q', '-m', 'stale output');
  assert.equal(run().status, 1);
  console.log('ok    regenerated changed output is rejected');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
