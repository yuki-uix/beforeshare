/**
 * The broken inputs the §7.1 fixture set cannot express.
 *
 * Every fixture under `fixtures/pdf/` is well-formed by construction, so none of
 * them can separate a robust parser from a brittle one — and robustness is the
 * only ground on which the heavier candidate in ADR 0002 could win. These six
 * are deliberately broken, each in one named way.
 *
 * Generated rather than committed as opaque bytes, for the reason §16.2 gives:
 * a file nobody can regenerate is a file nobody can check. Run with
 * `node experiments/generate-malformed.mjs`; the output is byte-identical.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'malformed');
mkdirSync(out, { recursive: true });

/** A known-good document, so each case differs from it in exactly one way. */
const base = readFileSync(join(here, '..', 'fixtures/pdf/files/document-metadata.positive.pdf'));

const cases = {
  /**
   * Every cross-reference offset one byte out. The table is structurally valid
   * and points at nothing — the case that made lenient loading return Ok with
   * zero objects.
   */
  'xref-offsets-off-by-one.pdf': () => {
    const i = base.indexOf('xref');
    const head = base.subarray(0, i);
    const tail = base.subarray(i).toString('latin1')
      .replace(/\d{10}/g, (n) => String(Number(n) + 1).padStart(10, '0'));
    return Buffer.concat([head, Buffer.from(tail, 'latin1')]);
  },

  /** No cross-reference table and no startxref: recovery or nothing. */
  'no-xref-table.pdf': () => Buffer.concat([
    base.subarray(0, base.indexOf('xref')),
    Buffer.from('%%EOF\n', 'latin1'),
  ]),

  /** A stream whose /Length claims far more than the file holds. */
  'stream-length-lies.pdf': () => Buffer.from(
    base.toString('latin1').replace('/Length 51', '/Length 9999'), 'latin1'),

  /** A trailer pointing at an object number that was never written. */
  'dangling-reference.pdf': () => Buffer.from(
    base.toString('latin1').replace('/Root 1 0 R', '/Root 99 0 R'), 'latin1'),

  /** Cut in half: everything after the midpoint is gone. */
  'truncated.pdf': () => base.subarray(0, Math.floor(base.length / 2)),

  /** An array nested far enough to find where a recursive parser gives up. */
  'deeply-nested-array.pdf': () => {
    const deep = `${'['.repeat(2000)}1${']'.repeat(2000)}`;
    return Buffer.from(
      base.toString('latin1').replace('/Type /Catalog', `/Type /Catalog /Deep ${deep}`),
      'latin1');
  },
};

for (const [name, build] of Object.entries(cases)) {
  const bytes = build();
  writeFileSync(join(out, name), bytes);
  console.log(`${name.padEnd(32)} ${String(bytes.length).padStart(7)} bytes`);
}
