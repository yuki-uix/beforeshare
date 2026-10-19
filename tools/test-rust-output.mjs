/** Run the actual Rust writer tests and expose only checks that really passed to §20.2. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const result = spawnSync('cargo', ['test', '-p', 'beforeshare-core', '--lib', 'safe_output::tests::'], {
  cwd: root, encoding: 'utf8', maxBuffer: 1 << 24,
});
if (result.error || result.status !== 0) {
  console.error(result.error ?? `${result.stdout}\n${result.stderr}`);
  process.exit(1);
}
const passed = [...result.stdout.matchAll(/^test safe_output::tests::([^ ]+) \.\.\. ok$/gm)];
if (passed.length < 12) throw new Error('Rust writer test selection was empty or incomplete');
for (const [, name] of passed) console.log(`ok    Rust ${name}`);
console.log(`\nPASS  ${passed.length} actual Rust writer tests`);
