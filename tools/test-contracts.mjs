#!/usr/bin/env node
/**
 * §20.3 contract boundaries, as a suite of their own.
 *
 * These overlap with tools/validate-schemas.mjs on purpose: that file checks the
 * committed artifacts, this one checks the rules those artifacts are supposed to
 * obey, using fixtures built in memory. A fixture here needs no PDF parser and no
 * real file — §20.3 is about the contract, and a contract test that depends on a
 * parser cannot run until the parser exists.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { computeStatus } from './status.mjs';
import { canConsume, resultIsStale, currentDetectorVersions, currentParserVersions, changelogViolations, parseVersion, BREAKING_KINDS, ADDITIVE_KINDS } from './versioning.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A suite that dies instead of failing reports nothing about the case it died
// on. Anything reading this output for failures — the CI guard among them —
// sees no FAIL line and concludes the guard stopped working, or worse, that
// nothing went wrong. Any escape becomes one FAIL line and a non-zero exit.
process.on('uncaughtException', (e) => {
  console.error(`FAIL  the suite aborted instead of reporting a failure\n        ${e?.stack ?? e}`);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error(`FAIL  the suite aborted on a rejected promise\n        ${e?.stack ?? e}`);
  process.exit(1);
});


// Only run when invoked directly. tools/validate-schemas.mjs discovers exported
// arrays by importing every module in this directory; a suite that ran on import
// would execute itself — and call process.exit — inside that scan.
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {

  const schemaDir = new URL('../schemas/v1/', import.meta.url);
  const readSchema = (f) => JSON.parse(readFileSync(new URL(f, schemaDir), 'utf8'));

  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  for (const f of readdirSync(schemaDir).filter((x) => x.endsWith('.schema.json'))) {
    ajv.addSchema(readSchema(f), f);
  }
  const validateInspection = ajv.getSchema('inspection-result.schema.json');

  let failures = 0;

  /**
   * An assertion whose expression throws must fail, not kill the suite.
   *
   * `check(name, subject())` evaluates its argument first, so a throwing subject
   * escapes before check runs: the process dies with a stack trace, no FAIL line
   * is printed, and anything reading the output for failures — the CI guard among
   * them — sees none. A suite that dies instead of failing reports nothing about
   * the case it died on.
   *
   * Passing a function defers the call to inside the try. Plain values still work,
   * so existing call sites are unaffected.
   */
  const check = (name, cond, detail) => {
    let value;
    try {
      value = typeof cond === 'function' ? cond() : cond;
    } catch (e) {
      failures += 1;
      console.error(`FAIL  ${name}\n        threw instead of returning: ${e?.reason ?? e?.message ?? e}`);
      return;
    }
    if (value) console.log(`ok    ${name}`);
    else { failures += 1; console.error(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
  };

  /** A minimal canonical result, built by hand. No parser, no file on disk. */
  const fixture = (over = {}) => ({
    schemaVersion: '1.0',
    runId: '01JR7N0A1B2C3D4E5F6G7H8J9K',
    input: {
      path: '/tmp/fixture.png',
      mediaType: 'image/png',
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      sizeBytes: 1024,
    },
    status: 'no_findings',
    coverage: { completed: ['image.exif', 'image.xmp', 'image.png_text', 'ocr.visible_text'], skipped: [], failed: [] },
    findings: [],
    limitations: [],
    versions: {
      core: '0.1.0',
      parsers: [{ id: 'image.png_parser', version: '1.0.0' }],
      detectors: [
        { id: 'image.exif', version: '1.0.0' },
        { id: 'image.xmp', version: '1.0.0' },
        { id: 'image.png_text', version: '1.0.0' },
        { id: 'ocr.visible_text', version: '0.4.1' },
      ],
    },
    startedAt: '2026-01-01T00:00:00Z',
    durationMs: 10,
    ...over,
  });

  // --- §20.3.1 every result validates against the committed schema -------------
  check('a minimal fixture validates', validateInspection(fixture()), JSON.stringify(validateInspection.errors));

  // --- §20.3.2 unknown enum values fail visibly --------------------------------
  for (const [where, mutate] of [
    ['status', (r) => { r.status = 'looks_ok'; }],
    ['finding category', (r) => { r.findings = [{ ...findingFixture(), category: 'not_a_category' }]; }],
    ['skip reason', (r) => { r.coverage.skipped.push({ detector: 'image.exif', reason: 'felt_like_it' }); }],
    ['limitation code', (r) => { r.limitations.push({ code: 'made_up', impact: 'coverage_incomplete', affectedDetectors: ['image.exif'], message: 'x' }); }],
  ]) {
    const doc = fixture();
    mutate(doc);
    check(`unknown ${where} value fails visibly`, !validateInspection(doc));
  }

  function findingFixture() {
    return {
      id: 'finding-1',
      category: 'image_gps_coordinates',
      group: 'image_metadata',
      severity: 'critical',
      certainty: 'deterministic',
      detector: { id: 'image.exif', version: '1.0.0' },
      location: { kind: 'exif', tagPath: 'GPS.GPSLatitude' },
      evidence: { displayValue: '31.2, 121.5', redacted: true, maskPolicy: 'coordinate_coarsened' },
      message: 'The image carries GPS coordinates.',
      remediation: { supported: true, action: 'remove_image_metadata_field', sideEffects: [] },
    };
  }

  // --- §20.3.3 missing coverage fails visibly ----------------------------------
  {
    const doc = fixture();
    delete doc.coverage;
    check('a result without coverage fails visibly', !validateInspection(doc));
  }
  {
    const doc = fixture();
    delete doc.coverage.skipped;
    check('a result with partial coverage information fails visibly', !validateInspection(doc));
  }

  // --- §20.3.4 partial cannot become no_findings -------------------------------
  // Checked against the rules, not against a string: presentation code cannot
  // reach a different answer than the one computeStatus produces.
  {
    const doc = fixture();
    doc.coverage.failed.push({ detector: 'ocr.visible_text', errorCode: 'timeout' });
    const computed = computeStatus(doc);
    check('a failed detector cannot yield no_findings', computed.status !== 'no_findings', computed.status);

    doc.status = 'no_findings';
    check('a hand-written no_findings disagrees with the rules and is detectable',
      computeStatus(doc).status !== doc.status);
  }
  {
    const doc = fixture();
    doc.coverage.skipped.push({ detector: 'ocr.visible_text', reason: 'cancelled' });
    check('a cancelled check cannot yield no_findings', computeStatus(doc).status !== 'no_findings');
  }
  {
    const doc = fixture({ cancelled: true });
    check('a cancelled run cannot yield no_findings', computeStatus(doc).status !== 'no_findings');
  }

  // --- §20.3.5 the three interfaces must produce equivalent results ------------
  // The registry is the teeth. An interface that claims to exist must name an
  // adapter, and the equivalence check runs for every implemented one. A skipped
  // test would have reported this whole surface as covered while nothing ran.
  const interfaces = readSchema('interface-registry.json').interfaces;
  const expected = ['cli', 'desktop', 'mcp'];
  check('every interface §14.1 names is in the registry',
    expected.every((k) => k in interfaces), Object.keys(interfaces).join(', '));
  check('no interface in the registry beyond the three',
    Object.keys(interfaces).every((k) => expected.includes(k)));

  const implemented = Object.entries(interfaces).filter(([, v]) => v.status === 'implemented');
  for (const [name, entry] of Object.entries(interfaces)) {
    if (entry.status === 'not_implemented') {
      check(`interface ${name} declares what it is waiting on`,
        typeof entry.waitingOn === 'string' && /^#\d+$/.test(entry.waitingOn) && entry.adapter === undefined,
        JSON.stringify(entry));
    } else if (entry.status === 'implemented') {
      check(`interface ${name} names an adapter`, typeof entry.adapter === 'string' && entry.adapter.length > 0);
    } else {
      check(`interface ${name} has a known status`, false, entry.status);
    }
  }

  if (implemented.length === 0) {
    console.log(`note  cross-interface equivalence has nothing to compare: 0 of ${expected.length} interfaces implemented`);
    console.log('note  this is recorded, not skipped — registering an interface starts the comparison immediately');
  } else {
    // Resolved from the repository root, which is how the registry's entry
    // reads: "tools/cli-adapter.mjs" is a path in this repository, not one
    // relative to whichever file happens to be doing the importing.
    const adapters = await Promise.all(implemented.map(async ([name, entry]) => {
      const mod = await import(new URL(`../${entry.adapter}`, import.meta.url).href);
      check(`interface ${name} exports produceResult`, typeof mod.produceResult === 'function');
      return [name, mod.produceResult];
    }));
    // A real file, because an interface produces a result by reading one. The
    // synthetic baseline above is a shape, and handing an adapter a path that
    // does not exist would test how each of them fails.
    const subject = fileURLToPath(new URL('../fixtures/pdf/files/form-fields.positive.pdf', import.meta.url));
    const outputs = await Promise.all(adapters.map(async ([name, fn]) => [name, await fn(subject)]));

    // Each output is validated on its own before any comparison. Comparing two
    // serialisations shows they agree, not that either is a canonical result:
    // with one interface registered the comparison loop below never runs, and
    // with two returning the same invalid object it passes. The first interface
    // to land is exactly the single-adapter case.
    for (const [name, out] of outputs) {
      check(`${name} produces a result that validates against the schema`,
        validateInspection(out), JSON.stringify(validateInspection.errors));
    }

    // Everything except what is per-run. §20.3 asks for equivalent canonical
    // results, and a run identifier that two interfaces agreed on would mean
    // they were the same run - common.schema.json says it is unique per run.
    // The same goes for when it started and how long it took.
    const comparable = (out) => {
      const { runId, startedAt, durationMs, ...rest } = out;
      return rest;
    };
    const [firstName, firstOut] = outputs[0];
    for (const [name, out] of outputs.slice(1)) {
      check(`${name} produces the same canonical result as ${firstName}`,
        isDeepStrictEqual(comparable(out), comparable(firstOut)));
    }
  }

  // --- §20.3.6 schema versions are explicit and compatibility is tested --------
  check('the fixture declares a schema version', typeof fixture().schemaVersion === 'string');
  {
    const doc = fixture();
    delete doc.schemaVersion;
    check('a result without a schema version fails visibly', !validateInspection(doc));
  }
  check('a consumer reads its own version', canConsume('1.0', '1.0').ok);
  check('a consumer reads an older minor', canConsume('1.0', '1.3').ok);
  check('a consumer refuses a newer minor', !canConsume('1.4', '1.0').ok);
  check('a consumer refuses a different major', !canConsume('2.0', '1.9').ok);
  check('a malformed version throws', (() => { try { parseVersion('1'); return false; } catch { return true; } })());

  check('breaking and additive kinds do not overlap',
    BREAKING_KINDS.every((k) => !ADDITIVE_KINDS.includes(k)));
  check('the changelog records no breaking change without a major bump',
    changelogViolations().length === 0, changelogViolations().join('; '));
  check('a breaking change without a major bump is caught',
    changelogViolations({ releases: [
      { version: '1.1', date: 'x', changes: [{ type: 'breaking', target: 't', description: 'd' }] },
      { version: '1.0', date: 'w', changes: [{ type: 'additive', target: 't', description: 'd' }] },
    ] }).length > 0);
  check('a breaking change in the very first release is caught',
    changelogViolations({ releases: [
      { version: '1.0', date: 'x', changes: [{ type: 'breaking', target: 't', description: 'd' }] },
    ] }).length > 0,
    'nothing existed to break; accepting it makes the check vacuous for a new schema');
  check('a breaking change with a major bump is allowed',
    changelogViolations({ releases: [
      { version: '2.0', date: 'y', changes: [{ type: 'breaking', target: 't', description: 'd' }] },
      { version: '1.0', date: 'x', changes: [{ type: 'additive', target: 't', description: 'd' }] },
    ] }).length === 0);

  // --- §14.1 a changed detector invalidates a stored result --------------------
  const current = { core: '0.1.0', parsers: currentParserVersions(), detectors: currentDetectorVersions() };
  check('an up-to-date result is not stale', resultIsStale(fixture(), current).stale === false,
    JSON.stringify(resultIsStale(fixture(), current).reasons));
  {
    const old = fixture();
    old.versions.detectors = old.versions.detectors.map((d) => (d.id === 'ocr.visible_text' ? { ...d, version: '0.3.0' } : d));
    const s = resultIsStale(old, current);
    check('a result from an older detector version is stale', s.stale, s.reasons.join('; '));
  }
  {
    const old = fixture();
    old.versions.core = '0.0.9';
    check('a result from an older core is stale', resultIsStale(old, current).stale);
  }
  {
    const old = fixture();
    old.versions.detectors = old.versions.detectors.filter((d) => d.id !== 'ocr.visible_text');
    check('a result missing a now-applicable detector is stale', resultIsStale(old, current).stale);
  }
  // §14.1 names parser versions alongside detector versions, and the parser is
  // the layer most likely to change what a detector can see.
  {
    const old = fixture();
    old.versions.parsers = [{ id: 'image.png_parser', version: '0.9.0' }];
    check('a result from an older parser version is stale', resultIsStale(old, current).stale);
  }
  {
    const old = fixture();
    old.versions.parsers = [{ id: 'image.gone_parser', version: '1.0.0' }];
    check('a result naming a parser that no longer exists is stale', resultIsStale(old, current).stale);
  }
  {
    const doc = fixture();
    delete doc.versions.parsers;
    check('a result without parser versions fails visibly (§14.1)', !validateInspection(doc));
  }

  {
    const pdfResult = fixture({ input: { ...fixture().input, mediaType: 'application/pdf', path: '/tmp/f.pdf' } });
    const s = resultIsStale(pdfResult, current);
    check('staleness is scoped by media type, not by every registered detector',
      s.reasons.every((r) => !r.includes('image.')), s.reasons.join('; '));
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  contract boundaries: ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);

}
