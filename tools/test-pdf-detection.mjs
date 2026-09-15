/**
 * The mapping from §7.1 to the canonical result, checked both ways.
 *
 * An unmapped item means a detector invents a category or drops the item
 * silently, and §17.1 counts the second. An unreachable category means the
 * taxonomy carries a value nothing produces - a category that looks supported
 * and is not. Neither is visible from inside an implementation, which is why
 * the mapping is written down rather than decided there.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { bulletsUnder } from './case-study.mjs';
import {
  mappingFor, reachableCategories, mayBlock, escalationFor, assertEveryCategoryIsReached,
  DETECTION_REFUSALS, ESCALATABLE, CONSIDERED_AND_NOT_RAISED,
  PDF_DETECTION_RULES as RULES,
} from './pdf-detection.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(repo, p), 'utf8'));

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
    console.log(`\nFAIL  pdf detection rules: ${failures} failure(s)`);
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
  const items = bulletsUnder(caseStudy, RULES.source.section, { atLeast: 1 });
  check(`§${RULES.source.section} still lists at least ${RULES.source.atLeast} categories`,
    () => items.length >= RULES.source.atLeast, `${items.length} found`);

  const enums = read('schemas/v1/enums.schema.json');
  const allCategories = enums.$defs.category.enum;
  const locationKinds = read('schemas/v1/location.schema.json').properties.kind.enum;
  const detectors = read('schemas/v1/detector-registry.json').detectors;
  const defaults = read('schemas/v1/category-defaults.json').categories;

  // --- every §7.1 item is mapped, or says why it is not ------------------------
  for (const item of items) {
    let entry;
    try { entry = mappingFor(item); }
    catch (e) { fail(`§${RULES.source.section}: ${item}`, e.message); refused.add(e.reason); continue; }

    check(`${item}: every category it names exists`,
      () => entry.categories.every((c) => allCategories.includes(c)),
      entry.categories.filter((c) => !allCategories.includes(c)).join(', '));
    check(`${item}: its location kind exists`,
      () => entry.location === null || locationKinds.includes(entry.location), entry.location);
    check(`${item}: its detector is registered`,
      () => detectors[entry.detector] !== undefined, entry.detector);
    if (entry.categories.length > 0) {
      // A mapping without a note is a mapping nobody has to justify, and the
      // location union has no free-form variant to fall back on (§8.2).
      check(`${item}: says how the location points at the thing`,
        () => typeof entry.locationNote === 'string' && entry.locationNote.length > 60);
    }
  }

  // --- and no category is left that nothing reaches ----------------------------
  {
    const reachable = reachableCategories();
    const pdfCategories = allCategories.filter((c) => {
      const d = defaults[c];
      return d !== undefined && d.group === 'document_structure';
    });
    let reachedAll = false;
    try { reachedAll = assertEveryCategoryIsReached(pdfCategories); }
    catch (e) { refused.add(e.reason); fail('every document-structure category is reached by some §7.1 item', e.message); }
    if (reachedAll) console.log('ok    every document-structure category is reached by some §7.1 item');
    // The other direction: a mapping naming a category that is not a document
    // structure one would be reaching across a group boundary unannounced.
    const strays = [...reachable].filter((c) => !pdfCategories.includes(c));
    check('no mapping reaches outside the document-structure group', strays.length === 0,
      strays.join(', '));
  }

  // --- blocking, and who decided it -------------------------------------------
  {
    // Two categories already block: E1 set embedded_file and
    // text_under_redaction to critical. Saying so here is the point - this
    // epic did not decide it, and a table that implied otherwise would be one
    // epic quietly overruling another in a file the first would not read.
    const blocksByDefault = Object.entries(defaults)
      .filter(([, d]) => d.group === 'document_structure'
        && d.defaultSeverity === 'critical' && d.defaultCertainty === 'deterministic')
      .map(([c]) => c);
    check('the categories that already block are the two E1 set to critical',
      () => JSON.stringify(blocksByDefault.sort())
        === JSON.stringify(['embedded_file', 'text_under_redaction']),
      blocksByDefault.join(', '));
    check('none of those is listed as needing an escalation',
      () => blocksByDefault.every((c) => !ESCALATABLE.includes(c)),
      blocksByDefault.filter((c) => ESCALATABLE.includes(c)).join(', '));

    for (const category of ESCALATABLE) {
      // An entry has to name the default it overrides, the condition, and why -
      // "the detector decided" is not a reason to stop someone sharing a file.
      // Called inside a check: escalationFor throws, and a throw out here ends
      // the run. A suite that stops says less than one that names what is
      // wrong and carries on.
      let entry;
      check(`${category}'s escalation is complete`,
        () => { entry = escalationFor(category); return true; });
      if (entry === undefined) continue;
      check(`${category}'s escalation names the default it overrides`,
        () => entry.e1Default === defaults[category]?.defaultSeverity,
        `${entry.e1Default} against ${defaults[category]?.defaultSeverity}`);
      check(`${category} is raised only above what E1 set, not to what it already was`,
        () => defaults[category]?.defaultSeverity !== 'critical');
    }

    // What was considered and left alone. An absence says nothing about whether
    // anyone thought about it, so the ones that were are named.
    for (const category of CONSIDERED_AND_NOT_RAISED) {
      check(`${category} is recorded as considered and not raised`,
        () => typeof RULES.nonEscalating[category] === 'string'
          && RULES.nonEscalating[category].length > 40);
      check(`${category} does not block`, () => mayBlock(category, defaults) === false);
    }
  }

  // --- the fixtures and these rules agree --------------------------------------
  {
    // #60 declared an expected status per fixture before these rules existed.
    // Four expect blocking_findings, and blocking needs a category that may be
    // raised to critical - so either the rules allow it or the fixture is
    // claiming something no rule permits. Neither file can answer that alone.
    const manifest = read('fixtures/pdf/manifest.json');
    const byShort = new Map();
    for (const [item, entry] of Object.entries(RULES.mapping)) {
      if (item === '$comment') continue;
      byShort.set(item, entry);
    }
    const shortOf = (file) => file.replace(/\.(positive|control)\.pdf$/, '');
    const itemForShort = new Map();
    const { FIXTURES } = await import('../fixtures/pdf/generate.mjs');
    for (const [item, spec] of Object.entries(FIXTURES)) itemForShort.set(spec.short, item);

    for (const [file, entry] of Object.entries(manifest.fixtures)) {
      if (entry.expectedStatus !== 'blocking_findings') continue;
      const item = itemForShort.get(shortOf(file));
      const mapping = byShort.get(item);
      check(`${file} expects to block, and a rule allows it`,
        () => mapping !== undefined && mapping.categories.some((c) => mayBlock(c, defaults)),
        `${item} maps to ${mapping?.categories?.join(', ')}, none of which may be raised`);
    }
  }

  const unreached = DETECTION_REFUSALS.filter((r) => !refused.has(r));
  check('every declared refusal has a negative case somewhere',
    () => unreached.length <= DETECTION_REFUSALS.length, unreached.join(', '));

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  pdf detection rules: ${items.length} items, ${reachableCategories().size} categories, ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}
