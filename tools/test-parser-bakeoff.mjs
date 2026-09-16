/**
 * The parser ADR's tables against the run that produced them.
 *
 * ADR 0002 decides between two parsers on measured outcomes, and its tables are
 * transcribed by hand from `experiments/results.tsv`. A transcription is exactly
 * the kind of number this repository has been wrong about before: it reads as
 * evidence and drifts silently. So every cell is checked against the file.
 *
 * Timings are deliberately not checked — they vary by machine, and the decision
 * does not rest on them.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// `validate-schemas.mjs` imports every module in tools/ to inspect what it
// exports, so a suite that runs at import time runs inside the validator - and
// this one ended with process.exit(0), which replaced the validator's own exit
// code. Sixteen unrelated guards reported "the suite passed; this guard no
// longer checks anything" in the same CI run. Every other suite here carries
// this line; this one did not.
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (!isMain) {
  // Imported for inspection, not to be run.
} else {

  const results = readFileSync(new URL('../experiments/results.tsv', import.meta.url), 'utf8');
  const adr = readFileSync(new URL('../docs/adr/0002-pdf-parser.md', import.meta.url), 'utf8');
  /** The ADR with quoted spans removed, for checks about what it asserts rather
   * than about what it quotes. */
  const adrWithoutQuotes = adr.replace(/"[^"\n]*"/g, '""');

  let failures = 0;
  const check = (name, ok, detail = '') => {
    if (ok) console.log(`ok    ${name}`);
    else { console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); failures += 1; }
  };

  /** Outcome text with the bracketed timing removed. */
  const withoutTiming = (cell) => cell.replace(/\s*\[[^\]]*\]\s*$/, '').trim();

  // The results file is what the ADR is checked against, so the results file has
  // to be checked against something too: the probe sources it came from. Editing a
  // probe without re-running used to leave every check green about numbers that no
  // longer described the code that produced them.
  {
    const { createHash } = await import('node:crypto');
    const here = new URL('../experiments/', import.meta.url);
    const sources = ['pdf-parser-bakeoff/src/main.rs', 'pdf-parser-bakeoff/Cargo.toml',
      'mupdf-probe/src/main.rs', 'mupdf-probe/Cargo.toml'];
    const hash = createHash('sha256');
    for (const rel of sources) hash.update(readFileSync(new URL(rel, here)));
    const current = hash.digest('hex');
    const recorded = results.match(/^# probes-sha256 ([0-9a-f]{64})$/m)?.[1];
    check('results.tsv records the probe sources it came from', Boolean(recorded));
    check('results.tsv was produced by the probes as they stand',
      recorded === current,
      `recorded ${recorded?.slice(0, 12)}, sources now ${current.slice(0, 12)} — run experiments/run.sh`);
  }

  const rows = results.split('\n').filter((l) => l && !l.startsWith('#'));
  const malformed = new Map();
  for (const line of rows) {
    const cells = line.split('\t');
    if (!/\.pdf$/.test(cells[1] ?? '')) continue;
    if (cells[0] === 'lopdf' && cells[2]?.startsWith('lenient:')) {
      malformed.set(`lopdf ${cells[1]}`, {
        lenient: withoutTiming(cells[2]).replace(/^lenient:\s*/, ''),
        strict: withoutTiming(cells[3]).replace(/^strict:\s*/, ''),
      });
    } else if (cells[0] === 'mupdf') {
      malformed.set(`mupdf ${cells[1]}`, { only: withoutTiming(cells[2]) });
    }
  }

  check('the results file carries both parsers on the malformed set',
    [...malformed.keys()].some((k) => k.startsWith('lopdf '))
    && [...malformed.keys()].some((k) => k.startsWith('mupdf ')),
    [...malformed.keys()].join(', '));

  /**
   * Each ADR row states four outcomes. The file names are not in the table — it
   * describes the inputs in prose — so the mapping is declared here and every
   * entry must match a row that exists, which is what makes a reworded row fail
   * rather than silently stop being checked.
   */
  const TABLE = [
    ['every xref offset one byte out', 'xref-offsets-off-by-one.pdf'],
    ['no xref table at all', 'no-xref-table.pdf'],
    ['a stream whose `/Length` lies', 'stream-length-lies.pdf'],
    ['a reference to a missing object', 'dangling-reference.pdf'],
    ['truncated halfway', 'truncated.pdf'],
    ['an array nested 2000 deep', 'deeply-nested-array.pdf'],
  ];

  /** "loaded, 6 objects" / "refused" / "refused: ..." reduced to what the ADR claims. */
  const claims = (cell) => {
    const text = cell.replace(/\*\*/g, '').trim();
    const loaded = text.match(/loaded,\s*(\d+)\s*objects/);
    if (loaded) return { kind: 'loaded', objects: Number(loaded[1]) };
    if (/^refused/.test(text)) return { kind: 'refused' };
    return { kind: 'unreadable', text };
  };

  const sameOutcome = (measured, stated) => {
    const a = claims(measured);
    const b = claims(stated);
    if (a.kind !== b.kind) return false;
    if (a.kind === 'loaded') return a.objects === b.objects;
    return true;
  };

  for (const [prose, file] of TABLE) {
    const line = adr.split('\n').find((l) => l.startsWith('|') && l.includes(prose));
    check(`ADR 0002 has a row for ${file}`, Boolean(line), prose);
    if (!line) continue;
    const cells = line.split('|').map((c) => c.trim()).filter((c, i, all) => i > 0 && i < all.length - 1);
    const [, lenient, strict, mupdf] = cells;

    const lo = malformed.get(`lopdf ${file}`);
    const mu = malformed.get(`mupdf ${file}`);
    check(`${file} was measured for both parsers`, Boolean(lo && mu));
    if (!lo || !mu) continue;

    check(`${file}: lopdf lenient matches the run`, sameOutcome(lo.lenient, lenient),
      `ADR says "${lenient}", the run says "${lo.lenient}"`);
    check(`${file}: lopdf strict matches the run`, sameOutcome(lo.strict, strict),
      `ADR says "${strict}", the run says "${lo.strict}"`);
    check(`${file}: mupdf matches the run`, sameOutcome(mu.only, mupdf),
      `ADR says "${mupdf}", the run says "${mu.only}"`);
  }

  // The row the decision rests on, asserted as a property rather than as a cell:
  // a successful load that yields nothing is the failure mode the ADR is about.
  const offByOne = malformed.get('lopdf xref-offsets-off-by-one.pdf');
  check('lenient loading of the off-by-one file really does succeed with no objects',
    claims(offByOne.lenient).kind === 'loaded' && claims(offByOne.lenient).objects === 0,
    offByOne.lenient);
  check('strict loading refuses it instead',
    claims(offByOne.strict).kind === 'refused', offByOne.strict);

  // How many planted disclosures each parser reaches. The ADR states these in
  // prose, and this check caught that prose being wrong: it read "both parsers
  // reach every one of the twelve" while the table two lines below said MuPDF
  // answers one of the content-stream items and not the other.
  const positives = rows.filter((l) => l.includes('.positive.pdf'));
  // Both reach all twelve. This started as 11 for MuPDF, from a probe that only
  // asked its structured-text API; reading the raw content stream - which the ADR
  // had claimed without measuring - reaches the twelfth.
  const EXPECTED_REACH = { lopdf: 12, mupdf: 12 };
  for (const [parser, expected] of Object.entries(EXPECTED_REACH)) {
    const mine = positives.filter((l) => l.startsWith(`${parser}\t`));
    const reached = mine.filter((l) => l.split('\t')[2] === 'reached');
    check(`${parser} reaches ${expected} of the twelve planted disclosures`,
      mine.length === 12 && reached.length === expected,
      `${reached.length} of ${mine.length} reached`);
    // And the ADR must say the same number in words, or the prose and the run
    // drift apart again in the other direction.
    const words = { 12: 'all twelve', 11: 'eleven' }[expected];
    check(`ADR 0002 states ${parser} reaches ${words}`,
      new RegExp(`${parser === 'lopdf' ? '`lopdf`' : 'MuPDF'} reaches ${words}`).test(adr));
    // And it must not still claim a capability gap the run does not show. Quoted
    // spans are stripped first: the ADR explains why "MuPDF reaches eleven" was
    // wrong, and a plain search fired on that explanation - the mirror image of a
    // coverage check once satisfied by a comment naming the rule it was checking.
    check(`ADR 0002 does not claim ${parser} misses one`,
      !/MuPDF reaches eleven/.test(adrWithoutQuotes));
  }

  // The malformed inputs are bytes in the repository, and §16.2's rule is that a
  // file nobody can regenerate is a file nobody can check. So the generator is run
  // into a scratch directory and compared - not trusted because a comment says so.
  {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, readdirSync, readFileSync: read, cpSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const here = new URL('../experiments/', import.meta.url).pathname;
    const scratch = mkdtempSync(join(tmpdir(), 'bs-malformed-'));
    try {
      cpSync(join(here, 'generate-malformed.mjs'), join(scratch, 'generate-malformed.mjs'));
      // The generator reads a fixture two levels up, so mirror that shape.
      cpSync(join(here, '..', 'fixtures'), join(scratch, '..', 'fixtures'), { recursive: true, force: false, errorOnExist: false });
      execFileSync(process.execPath, [join(scratch, 'generate-malformed.mjs')], { stdio: 'pipe' });
      const committed = readdirSync(join(here, 'malformed')).filter((f) => f.endsWith('.pdf')).sort();
      const made = readdirSync(join(scratch, 'malformed')).filter((f) => f.endsWith('.pdf')).sort();
      check('the generator produces exactly the committed set',
        JSON.stringify(committed) === JSON.stringify(made),
        `${committed.join(',')} vs ${made.join(',')}`);
      for (const name of committed) {
        const a = read(join(here, 'malformed', name));
        const b = read(join(scratch, 'malformed', name));
        check(`${name} is byte-identical to what the generator makes`, a.equals(b),
          `${a.length} bytes committed, ${b.length} bytes generated`);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  parser bake-off: ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}
