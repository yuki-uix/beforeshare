/**
 * The §7.1 fixtures: are they there, are they what they claim, do they open.
 *
 * Three different questions, and the third is the one a fixture set usually
 * fails silently. A file that is committed, labelled and never opened by
 * anything is a fixture in name; the offsets in its cross-reference table were
 * computed by hand here, and a wrong one produces a file that every real parser
 * refuses while the suite reports twelve categories covered.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { bulletsUnder } from './case-study.mjs';
import { FIXTURES, generateAll, EVAL_VERSION } from '../fixtures/pdf/generate.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const RULES = JSON.parse(readFileSync(join(repo, 'schemas/v1/fixture-rules.json'), 'utf8'));
const ENUMS = JSON.parse(readFileSync(join(repo, 'schemas/v1/enums.schema.json'), 'utf8'));
const STATUS_VALUES = ENUMS.$defs.status.enum;
const REMEDIATION_ACTIONS = ENUMS.$defs.remediationAction.enum;

/**
 * Whether a PDF's cross-reference table points at real objects.
 *
 * Not a full parse - a structural check of the one thing written by hand here.
 * A reader finds objects through this table, so an offset that is off by a byte
 * makes the file unopenable while leaving it superficially intact.
 */
/**
 * Whether every declared stream length is the length of its data.
 *
 * A /Length that disagrees makes the file a test of malformed streams, whichever
 * category it was meant to be about. Found here as 44 against 45 - one byte, and
 * the embedded-file fixture was about something else entirely.
 */
export function streamLengthsAgree(bytes) {
  const text = bytes.toString('binary');
  const wrong = [];
  for (const m of text.matchAll(/\/Length (\d+)[^>]*>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    if (Number(m[1]) !== m[2].length) wrong.push(`declared ${m[1]}, found ${m[2].length}`);
  }
  return { agree: wrong.length === 0, wrong };
}

/**
 * Whether any dictionary declares the same key twice.
 *
 * PDF leaves a duplicated key undefined, so the fixture becomes a test of what
 * this parser happens to do. /Resources appeared twice in one page object here,
 * added once by the scaffold and once by the fixture.
 */
export function noDuplicateKeys(bytes) {
  const text = bytes.toString('binary');
  const offenders = [];
  for (const object of text.matchAll(/\d+ 0 obj\s*<<([\s\S]*?)>>\s*(?:stream|endobj)/g)) {
    const topLevel = object[1].replace(/<<[\s\S]*?>>/g, '');
    const seen = new Set();
    for (const key of topLevel.matchAll(/\/([A-Za-z]+)\s/g)) {
      if (seen.has(key[1])) offenders.push(`/${key[1]}`);
      seen.add(key[1]);
    }
  }
  return { clean: offenders.length === 0, offenders };
}

/**
 * Whether an incremental update's /Prev points at a cross-reference table.
 *
 * It must point at the previous table, not the end of the previous file. A
 * parser following the chain otherwise lands on an object, gives up, and never
 * reaches the revision the fixture exists to expose - so the fixture passes
 * every other check while demonstrating nothing.
 */
export function previousTablesAreReachable(bytes) {
  const text = bytes.toString('binary');
  const broken = [];
  for (const m of text.matchAll(/\/Prev (\d+)/g)) {
    const at = Number(m[1]);
    if (text.slice(at, at + 4) !== 'xref') {
      broken.push(`/Prev ${at} points at ${JSON.stringify(text.slice(at, at + 10))}`);
    }
  }
  return { reachable: broken.length === 0, broken };
}

export function crossReferenceIsSound(bytes) {
  const text = bytes.toString('binary');
  const startxref = text.lastIndexOf('startxref');
  if (startxref === -1) return { sound: false, why: 'no startxref' };
  const offset = Number.parseInt(text.slice(startxref + 'startxref'.length).trim(), 10);
  if (!Number.isFinite(offset)) return { sound: false, why: 'startxref is not a number' };
  if (text.slice(offset, offset + 4) !== 'xref') {
    return { sound: false, why: `startxref points at ${JSON.stringify(text.slice(offset, offset + 8))}` };
  }
  const entries = [...text.slice(offset).matchAll(/^(\d{10}) 00000 n /gm)];
  if (entries.length === 0) return { sound: false, why: 'the table lists no objects in use' };
  for (const entry of entries) {
    const target = Number.parseInt(entry[1], 10);
    if (!/^\d+ 0 obj/.test(text.slice(target, target + 20))) {
      return { sound: false, why: `offset ${target} is not the start of an object` };
    }
  }
  return { sound: true, entries: entries.length };
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  let failures = 0;
  const refused = new Set();
  const fail = (name, detail) => {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  };
  process.on('uncaughtException', (e) => {
    fail('the suite aborted instead of reporting a failure', e?.stack ?? String(e));
    console.log(`\nFAIL  pdf fixtures: ${failures} failure(s)`);
    process.exit(1);
  });
  const check = (name, cond, detail) => {
    let value;
    try { value = typeof cond === 'function' ? cond() : cond; }
    catch (e) { fail(name, `threw instead of returning: ${e?.reason ?? e?.message ?? e}`); return; }
    if (value) console.log(`ok    ${name}`);
    else fail(name, detail);
  };

  const caseStudy = readFileSync(join(repo, RULES.source.document), 'utf8');
  const categories = bulletsUnder(caseStudy, RULES.source.section,
    { atLeast: RULES.source.atLeast });
  check(`§${RULES.source.section} still lists at least ${RULES.source.atLeast} categories`,
    () => categories.length >= RULES.source.atLeast, `${categories.length} found`);

  // --- every category has both kinds ------------------------------------------
  for (const category of categories) {
    const spec = FIXTURES[category];
    if (spec === undefined) {
      fail(`§${RULES.source.section}: ${category}`,
        'no fixture claims this category; the detection rate this repository reports is a fraction, and a category with no fixture is missing from the denominator');
      refused.add('category_uncovered');
      continue;
    }
    check(`${category} has both a must_detect and a clean_control`,
      () => typeof spec.must_detect === 'function' && typeof spec.clean_control === 'function');
  }
  const stale = Object.keys(FIXTURES).filter((k) => !categories.includes(k));
  check('no fixture claims a category the case study dropped', stale.length === 0,
    stale.join(' / '));

  // --- the files match what the generator produces ------------------------------
  const dir = join(repo, 'fixtures/pdf/files');
  check('the fixtures have been generated', existsSync(dir));
  const fresh = generateAll(join(repo, 'fixtures/pdf/.verify'));
  const committed = readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort();
  check('every generated file is committed',
    () => fresh.every((f) => committed.includes(f.file)),
    fresh.filter((f) => !committed.includes(f.file)).map((f) => f.file).join(', '));
  check('no committed file is left over from a generator that changed',
    () => committed.every((f) => fresh.some((g) => g.file === f)),
    committed.filter((f) => !fresh.some((g) => g.file === f)).join(', '));

  for (const f of fresh) {
    const onDisk = readFileSync(join(dir, f.file));
    const hash = createHash('sha256').update(onDisk).digest('hex');
    // A fixture edited by hand becomes its own label, and the label it was
    // given stops describing it.
    if (hash !== f.sha256) refused.add('fixture_drifted');
    check(`${f.file} is byte-identical to what the generator produces`,
      () => hash === f.sha256, `${hash.slice(0, 12)} vs ${f.sha256.slice(0, 12)}`);
  }

  // --- and they open --------------------------------------------------------
  for (const f of fresh) {
    const result = crossReferenceIsSound(readFileSync(join(dir, f.file)));
    check(`${f.file} has a cross-reference table pointing at real objects`,
      () => result.sound === true, result.why);
  }

  // --- and they say what they contain -----------------------------------------
  for (const f of fresh) {
    const bytes = readFileSync(join(dir, f.file));
    const lengths = streamLengthsAgree(bytes);
    check(`${f.file} declares stream lengths that match the data`, () => lengths.agree,
      lengths.wrong.join(' / '));
    const keys = noDuplicateKeys(bytes);
    check(`${f.file} declares no dictionary key twice`, () => keys.clean, keys.offenders.join(' '));
    const chain = previousTablesAreReachable(bytes);
    check(`${f.file} points /Prev at a cross-reference table`, () => chain.reachable,
      chain.broken.join(' / '));
  }

  // --- provenance: §16.2's nine fields ----------------------------------------
  const manifestPath = join(repo, 'fixtures/pdf/manifest.json');
  check('the manifest is there', existsSync(manifestPath));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const f of fresh) {
    const entry = manifest.fixtures[f.file];
    if (entry === undefined) { fail(`${f.file} is in the manifest`, 'missing'); continue; }
    const missing = RULES.provenance.required.filter((field) => {
      const value = entry[field];
      return value === undefined || value === null || value === '';
    });
    if (missing.length > 0) refused.add('provenance_incomplete');
    check(`${f.file} carries all §16.2 provenance fields`, missing.length === 0,
      missing.join(', '));
    check(`${f.file}'s recorded hash is its actual hash`,
      () => entry.sha256 === f.sha256, `${entry.sha256?.slice(0, 12)} vs ${f.sha256.slice(0, 12)}`);
    check(`${f.file} is tagged ${EVAL_VERSION}`, () => entry.evalVersion === EVAL_VERSION,
      entry.evalVersion);
    // The expectations are strings until something reads them, so the least
    // they can do is be strings the result schema recognises. A typo in a
    // status is otherwise a label nobody will notice is wrong until a detector
    // disagrees with it for the wrong reason.
    check(`${f.file} expects a status the schema has`,
      () => STATUS_VALUES.includes(entry.expectedStatus), entry.expectedStatus);
    check(`${f.file} expects a coverage the result schema has`,
      () => ['completed', 'skipped', 'failed'].includes(entry.expectedCoverage),
      entry.expectedCoverage);
    check(`${f.file} expects a remediation action that exists, or none`,
      () => entry.expectedRemediation === 'none'
        || REMEDIATION_ACTIONS.includes(entry.expectedRemediation),
      entry.expectedRemediation);
  }

  // --- a control that is nothing like its positive tests nothing ----------------
  for (const [category, spec] of Object.entries(FIXTURES)) {
    const positive = spec.must_detect();
    const control = spec.clean_control();
    check(`${spec.short}: the control is not the positive`, () => !positive.equals(control));
    // §17.1 counts clean controls given a blocking finding. A control that
    // shares no structure with its positive cannot exercise that: the detector
    // would have to be wrong about something it never sees.
    //
    // Two attempts before this measured nothing. A byte ratio never fired - the
    // closest pair sat at 0.68 against a floor of 0.5. Object counts were no
    // better: an unrelated five-object document differs from a six-object
    // positive by one, so it passed while sharing nothing at all. What "the
    // same document" means is the set of object roles, so that is compared.
    const roles = (bytes) => {
      const text = bytes.toString('binary');
      const found = new Set();
      for (const m of text.matchAll(/\/Type\s*\/([A-Za-z]+)/g)) found.add(m[1]);
      for (const key of ['Pages', 'Contents', 'MediaBox', 'Resources']) {
        if (text.includes(`/${key}`)) found.add(key);
      }
      return found;
    };
    const inPositive = roles(positive);
    const inControl = roles(control);
    const shared = [...inPositive].filter((r) => inControl.has(r));
    check(`${spec.short}: the control is built from the same document as the positive`,
      () => inPositive.size > 0 && shared.length >= inPositive.size - 2 && shared.length >= 4,
      `positive ${[...inPositive].sort().join(',')} / control ${[...inControl].sort().join(',')}`);
  }

  // --- every declared refusal has a negative case that reaches it --------------
  //
  // The first version asserted that none had fired during a passing run, which
  // is true of a run where nothing checks them - and left provenance_incomplete
  // with no case anywhere. Each refusal now says where its negative lives, and
  // that is checked: in_suite means it is broken here on a copy and the reason
  // has to come back; in_ci means reaching it requires editing the source of
  // truth, so the workflow has to carry a mutation for it.
  {
    const breaks = {
      category_uncovered: () => (categories.some((c) => FIXTURES[c] === undefined)
        ? 'category_uncovered' : null),
      provenance_incomplete: () => {
        const entry = { ...manifest.fixtures[fresh[0].file] };
        delete entry[RULES.provenance.required[4]];
        const missing = RULES.provenance.required.filter((field) => {
          const value = entry[field];
          return value === undefined || value === null || value === '';
        });
        return missing.length > 0 ? 'provenance_incomplete' : null;
      },
      fixture_drifted: () => {
        const bytes = Buffer.from(readFileSync(join(dir, fresh[0].file)));
        bytes[bytes.length - 10] ^= 0xFF;
        return createHash('sha256').update(bytes).digest('hex') !== fresh[0].sha256
          ? 'fixture_drifted' : null;
      },
    };
    const declared = Object.keys(RULES.refusals).filter((k) => k !== '$comment');
    const workflow = readFileSync(join(repo, '.github/workflows/contracts.yml'), 'utf8');
    for (const reason of declared) {
      const where = RULES.refusals[reason].negativeCase;
      check(`${reason} says where its negative case lives`,
        () => ['in_suite', 'in_ci'].includes(where), where);
      if (where === 'in_suite') {
        check(`${reason} has a break here that reaches it`,
          () => typeof breaks[reason] === 'function' && breaks[reason]() === reason);
      }
      if (where === 'in_ci') {
        check(`${reason} has a mutation case in the workflow`,
          () => workflow.includes('a §7.1 category with no fixture'),
          'no expect_failure names it');
        check(`${reason} does not fire on a healthy tree`,
          () => breaks[reason]?.() === null,
          'it fired, which means a category is genuinely uncovered');
      }
    }
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  pdf fixtures: ${categories.length} categories, ${fresh.length} files, ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}
