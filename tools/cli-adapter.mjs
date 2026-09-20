/**
 * The command line, as the equivalence suite sees it.
 *
 * §20.3 requires the three interfaces to produce equivalent canonical results,
 * and `interface-registry.json` says an interface counts as implemented only
 * when a module here exports `produceResult`. This one runs the real binary:
 * an adapter that called the core directly would be checking the core against
 * itself and would pass while the command line printed something else.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where the binary is. Overridable because a release build puts it elsewhere;
 * missing is an error rather than a skip - an interface that cannot be run is
 * not an interface that agrees.
 */
export function binary() {
  const path = process.env.BEFORESHARE_BIN ?? join(root, 'target', 'debug', 'beforeshare');
  if (!existsSync(path)) {
    throw new Error(
      `the command line is not built at ${path}: run \`cargo build\` or set BEFORESHARE_BIN`);
  }
  return path;
}

/** Run it, and hand back stdout, stderr and the exit code without judging them. */
export function run(args, { cwd = root } = {}) {
  const result = spawnSync(binary(), args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`CLI terminated by ${result.signal}`);
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', code: result.status };
}

/** The canonical result for one file, as the registry's contract requires. */
export function produceResult(path) {
  const { stdout, stderr, code } = run(['inspect', path, '--json']);
  if (stdout.trim() === '') {
    throw new Error(`inspect ${path} produced no result (exit ${code}): ${stderr.trim()}`);
  }
  return JSON.parse(stdout);
}
