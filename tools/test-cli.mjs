/**
 * The command line, run as a process.
 *
 * Everything here goes through the binary. A test that called the core would
 * prove the core works, which other suites already do; what is unproven until
 * a process runs is that the exit code, stdout and stderr agree with each other
 * and with the result - #24 left exactly that here, because it needs a real
 * process to be true or false about.
 */
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, symlinkSync, openSync, ftruncateSync, closeSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { canConsume } from './versioning.mjs';
import { boundaryFixtures, boundaryManifest } from '../fixtures/pdf/generate-boundaries.mjs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { run } from './cli-adapter.mjs';
import { STATUS_EXIT_MATRIX } from './exit-codes.mjs';
import { buildPdf, minimalDocument, streamObject } from '../fixtures/pdf/pdf-writer.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const schemaDir = join(root, 'schemas', 'v1');
const filesDir = join(root, 'fixtures', 'pdf', 'files');

/**
 * A document that blocks and cannot be fully checked at once.
 *
 * An embedded file is a blocking finding; an image leaves the OCR gap open, and
 * a gap makes the coverage incomplete. Built with the writer the fixtures use,
 * because a hand-written one got its stream lengths wrong and strict loading
 * refused it - which reported as "failed" and would have read as this pairing
 * being impossible.
 *
 * Not added to the fixture set: §16.1's fixtures each carry one §7.1 item, and
 * this carries two on purpose. It is about the exit code, not about a detector.
 */
function buildBlockingIncompletePdf() {
  return buildPdf(minimalDocument({
    catalogueExtra: ' /Names << /EmbeddedFiles << /Names [(payroll.csv) 7 0 R] >> >>',
    contents: 'q 612 0 0 792 0 0 cm /Im1 Do Q',
    resourcesExtra: ' /XObject << /Im1 6 0 R >>',
    extraObjects: [
      streamObject('\u0000\u00FF\u00FF\u0000', {
        dictExtra: ' /Type /XObject /Subtype /Image /Width 2 /Height 2'
          + ' /ColorSpace /DeviceGray /BitsPerComponent 8',
      }),
      '<< /Type /Filespec /F (payroll.csv) >>',
    ],
  }));
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  let failures = 0;
  const check = (name, ok, detail = '') => {
    if (ok) console.log(`ok    ${name}`);
    else { failures += 1; console.error(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
  };

  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  for (const f of readdirSync(schemaDir).filter((f) => f.endsWith('.schema.json'))) {
    ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, f), 'utf8')), f);
  }
  const validateResult = ajv.getSchema('inspection-result.schema.json');
  const validateCapabilities = ajv.getSchema('capabilities.schema.json');
  const manifest = JSON.parse(readFileSync(join(root, 'fixtures/pdf/manifest.json'), 'utf8'));
  const changelog = JSON.parse(readFileSync(join(schemaDir, 'CHANGELOG.json'), 'utf8'));
  const currentSchemaVersion = changelog.releases[0].version;
  const versionInfo = JSON.parse(run(['version', '--json']).stdout);
  const capabilityInfo = JSON.parse(run(['capabilities', '--json']).stdout);
  check('changelog format version agrees with its current release', changelog.schemaVersion === currentSchemaVersion);
  check('CLI version and capabilities share the current contract', versionInfo.schemaVersion === currentSchemaVersion && capabilityInfo.schemaVersion === currentSchemaVersion);
  check('a 1.0 consumer refuses the actual current CLI contract', !canConsume(versionInfo.schemaVersion, '1.0').ok);
  for (const name of ['no-findings.json', 'review-required.json', 'partial.json']) {
    const old = JSON.parse(readFileSync(join(schemaDir, 'examples', name), 'utf8'));
    check(`${name}: the current consumer still accepts the historical 1.0 result`, old.schemaVersion === '1.0' && canConsume(old.schemaVersion, currentSchemaVersion).ok && validateResult(old));
  }


  // --- 1. every fixture, through the process ---------------------------------
  //
  // The matrix is read from the same table the binary reads. A status paired
  // with a code neither of them allows is the disagreement #24 asked about.
  const fixtures = readdirSync(filesDir).filter((f) => f.endsWith('.pdf')).sort();
  check('there are fixtures to run', fixtures.length > 0);
  const seenCodes = new Set();
  for (const name of fixtures) {
    const path = join(filesDir, name);
    const { stdout, stderr, code } = run(['inspect', path, '--json']);

    let result = null;
    try { result = JSON.parse(stdout); } catch { /* reported below */ }
    check(`${name}: result declares the same contract as version/capabilities`, result?.schemaVersion === currentSchemaVersion);
    check(`${name}: stdout is JSON and nothing else`, result !== null,
      `exit ${code}, stdout starts ${JSON.stringify(stdout.slice(0, 80))}`);
    if (result === null) continue;

    check(`${name}: the result validates`, validateResult(result),
      (validateResult.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join('; '));
    check(`${name}: the status is the one its fixture expects`,
      result.status === manifest.fixtures[name].expectedStatus,
      `expected ${manifest.fixtures[name].expectedStatus}, got ${result.status}`);
    check(`${name}: the exit code is one this status may have`,
      (STATUS_EXIT_MATRIX[result.status] ?? []).includes(code),
      `status ${result.status} with exit ${code}, allowed ${JSON.stringify(STATUS_EXIT_MATRIX[result.status])}`);
    check(`${name}: diagnostics did not land on stdout`, stderr === '' || !stdout.includes(stderr));
    seenCodes.add(code);

    // The human rendering is the default, and the default must not print what
    // the JSON masked. Same declared values the results suite uses.
    const human = run(['inspect', path]);
    const leaked = (manifest.fixtures[name].mustNotLeak ?? []).filter((v) => human.stdout.includes(v));
    check(`${name}: the human output carries none of the document's values`,
      leaked.length === 0, leaked.join(', '));
  }

  // Boundary data is regenerated in memory, so neither committed PDFs nor
  // labels can silently drift. Run every case through the public process.
  const boundaryDir = join(root, 'fixtures/pdf/boundaries');
  check('the boundary corpus has at least sixteen cases', boundaryFixtures().length >= 16);
  check('boundary labels match their generator',
    JSON.stringify(JSON.parse(readFileSync(join(boundaryDir, 'manifest.json')))) === JSON.stringify(boundaryManifest()));
  for (const fixture of boundaryFixtures()) {
    const path = join(boundaryDir, fixture.name);
    check(`${fixture.name}: bytes match the deterministic generator`, readFileSync(path).equals(fixture.bytes));
    const { stdout, code } = run(['inspect', path, '--json']);
    const value = JSON.parse(stdout);
    check(`${fixture.name}: canonical result validates`, validateResult(value), JSON.stringify(validateResult.errors));
    check(`${fixture.name}: result version is current and rejected by a 1.0 consumer`, value.schemaVersion === currentSchemaVersion && !canConsume(value.schemaVersion, '1.0').ok);
    check(`${fixture.name}: status matches the boundary label`, value.status === fixture.expectedStatus, value.status);
    check(`${fixture.name}: exit agrees with coverage`, STATUS_EXIT_MATRIX[value.status].includes(code));
    const failed = value.coverage.failed.map(({ detector, errorCode }) => ({ detector, errorCode }));
    check(`${fixture.name}: failed checks are exact`, JSON.stringify(failed) === JSON.stringify(fixture.expectedFailed));
    for (const category of fixture.expectedCategories) {
      check(`${fixture.name}: expected finding ${category} is present`, value.findings.some((f) => f.category === category));
    }
    for (const { detector } of fixture.expectedFailed) {
      check(`${fixture.name}: unsupported check is not completed`, !value.coverage.completed.includes(detector));
      check(`${fixture.name}: gap is explained`, value.limitations.some((l) => l.affectedDetectors.includes(detector)));
    }
    check(`${fixture.name}: document values stay out of diagnostics`, !JSON.stringify(value).includes('SYNTHETIC-XMP-42') && !JSON.stringify(value).includes('SYNTHETIC-HIDDEN-42'));
  }

  // Both halves of the one status that has two codes. Without this the pair is
  // a claim about a branch nothing reached.
  check('a complete run and an incomplete one produced different codes',
    seenCodes.has(0) && seenCodes.has(4), [...seenCodes].join(', '));

  // --- 2. what is outside the supported set ----------------------------------
  const scratch = mkdtempSync(join(tmpdir(), 'beforeshare-cli-'));
  // Metadata rejects a sparse oversized file before reading or hashing it.
  const budgets = JSON.parse(readFileSync(join(schemaDir, 'limit-rules.json'))).budgets;
  const oversized = join(scratch, 'oversized.pdf');
  const fd = openSync(oversized, 'w');
  try { ftruncateSync(fd, budgets.inputBytes.default + 1); } finally { closeSync(fd); }
  const sizeStarted = performance.now();
  const refused = run(['inspect', oversized, '--json']);
  check('oversized sparse input exits 4 with a named refusal', refused.code === 4 && refused.stderr.includes('input_too_large'));
  check('oversized input does not fabricate a hash or result', refused.stdout === '');
  check('oversized input is rejected promptly', performance.now() - sizeStarted < 5000);
  rmSync(oversized);

  const exact = join(filesDir, 'invisible-text.control.pdf');
  const exactSize = readFileSync(exact).length;
  const allowed = run(['inspect', exact, '--json', '--max-input-bytes', String(exactSize)]);
  check('a file exactly at the input limit is inspected', allowed.code === 0 && JSON.parse(allowed.stdout).status === 'no_findings');
  const over = run(['inspect', exact, '--json', '--max-input-bytes', String(exactSize - 1)]);
  check('one byte over the input limit is refused', over.code === 4 && over.stdout === '' && over.stderr.includes('input_too_large'));
  for (const [option, bad] of [
    ['--max-input-bytes', '0'], ['--max-input-bytes', '-1'], ['--max-input-bytes', 'NaN'],
    ['--max-input-bytes', String(budgets.inputBytes.default + 1)],
    ['--timeout-ms', '0'], ['--timeout-ms', '1.5'], ['--timeout-ms', String(budgets.wallClockMs.default + 1)],
  ]) {
    const invalid = run(['inspect', exact, '--json', option, bad]);
    check(`${option} rejects ${bad}`, invalid.code === 2 && invalid.stdout === '');
  }
  for (const args of [
    ['inspect', exact, '--timeout-ms'],
    ['inspect', exact, '--timeout-ms', '1', '--timeout-ms', '2'],
    ['version', '--max-input-bytes', '1'],
  ]) check(`invalid limit arguments are refused: ${args.join(' ')}`, run(args).code === 2);

  // A large valid content stream makes real parsing exceed a deliberately
  // reduced deadline. No mock clock or environment-variable delay hook.
  const slow = join(scratch, 'slow.pdf');
  const slowBytes = buildPdf(minimalDocument({ contents: 'q Q\n'.repeat(1_000_000) }));
  writeFileSync(slow, slowBytes);
  const timeoutStarted = performance.now();
  const timedOut = run(['inspect', slow, '--json', '--timeout-ms', '10']);
  check('a real inspection times out with exit 5', timedOut.code === 5 && timedOut.stderr.includes('timeout'));
  check('a timed-out worker publishes no partial JSON', timedOut.stdout === '');
  check('timeout returns without waiting for parsing to finish', performance.now() - timeoutStarted < 5000);
  check('timeout preserves the original bytes', createHash('sha256').update(readFileSync(slow)).digest('hex') === createHash('sha256').update(slowBytes).digest('hex'));
  const privateWorker = run(['--inspection-worker', 'inspect', slow, '--json', '--timeout-ms', '10']);
  check('the private worker cannot bypass its own deadline', privateWorker.code !== 0 && privateWorker.stdout === '');
  rmSync(slow);
  check('a normal inspection completes under a reduced deadline', run(['inspect', exact, '--timeout-ms', '5000']).code === 0);

  // A compact input can expand into far more JSON than input bytes. Exercise
  // the real parent's combined-output budget, not just the pipe reader helper.
  const noisy = join(scratch, 'many-annotations.pdf');
  writeFileSync(noisy, buildPdf(minimalDocument({
    pageExtra: ` /Annots [${'6 0 R '.repeat(32_000)}]`,
    extraObjects: ['<< /Type /Annot /Subtype /Text /Rect [0 0 10 10] /Contents (Synthetic annotation) >>'],
  })));
  const outputRefusal = run(['inspect', noisy, '--json']);
  check('expanded worker output is refused with exit 5', outputRefusal.code === 5 && outputRefusal.stderr.includes('resource_limit_exceeded'));
  check('output refusal publishes no truncated JSON', outputRefusal.stdout === '');
  rmSync(noisy);

  const notPdf = join(scratch, 'notes.txt');
  writeFileSync(notPdf, 'this is not a PDF, whatever the name says');
  {
    const { stdout, code } = run(['inspect', notPdf, '--json']);
    const result = JSON.parse(stdout);
    check('an unsupported input is unsupported, not failed', result.status === 'unsupported',
      result.status);
    check('an unsupported input exits 3', code === 3, String(code));
  }
  // A PDF with something in front of its header. Real files have it - a
  // byte-order mark, a stray newline, a gateway's preamble - and the core reads
  // them: measured, seven detectors complete and two findings come out. The
  // command used to answer "not a format I check", which is the worst answer
  // available, because it reads as permission to carry on sharing.
  for (const [label, prefix] of [['a newline', '\n'], ['a byte-order mark', '\uFEFF']]) {
    const shifted = join(scratch, `shifted-${label.replace(/\W/g, '')}.pdf`);
    writeFileSync(shifted, Buffer.concat([
      Buffer.from(prefix, 'utf8'),
      readFileSync(join(filesDir, 'form-fields.positive.pdf')),
    ]));
    const { stdout, code } = run(['inspect', shifted, '--json']);
    const result = JSON.parse(stdout);
    check(`a PDF behind ${label} is still a PDF`,
      result.input.mediaType === 'application/pdf', result.input.mediaType);
    check(`a PDF behind ${label} is inspected rather than declined`,
      result.findings.length > 0 && code !== 3,
      `${result.status}, ${result.findings.length} findings, exit ${code}`);
  }

  // Named .pdf and not a PDF: the extension is a claim by whoever named it.
  const lying = join(scratch, 'report.pdf');
  writeFileSync(lying, 'still not a PDF');
  {
    const { stdout, code } = run(['inspect', lying, '--json']);
    check('the format comes from the bytes, not the name',
      JSON.parse(stdout).status === 'unsupported' && code === 3, String(code));
  }

  // --- 2b. a file this build cannot read at all -------------------------------
  //
  // A PDF by its bytes and not a document by its structure: the run started and
  // could not finish, which is the difference between 5 and 3.
  const broken = join(scratch, 'truncated.pdf');
  writeFileSync(broken, '%PDF-1.7\n1 0 obj\n<< /Type /Catalog\n');
  {
    const { stdout, code } = run(['inspect', broken, '--json']);
    const result = JSON.parse(stdout);
    check('a file that cannot be read is failed, not unsupported',
      result.status === 'failed', result.status);
    check('a failed run exits 5', code === 5, String(code));
    check('a failed run still produces a result on stdout', validateResult(result),
      (validateResult.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join('; '));
  }

  // --- 2c. the path gate is in front of the read ------------------------------
  //
  // §13.4 is about every access. The gate authorises the directory the user
  // named, so a link out of it is refused before anything opens it - the user
  // asked about a file in a place, not about wherever that name points.
  {
    const outside = mkdtempSync(join(tmpdir(), 'beforeshare-elsewhere-'));
    const secret = join(outside, 'payroll.pdf');
    writeFileSync(secret, readFileSync(join(filesDir, 'form-fields.positive.pdf')));
    const link = join(scratch, 'innocent.pdf');
    symlinkSync(secret, link);
    const { stdout, stderr, code } = run(['inspect', link, '--json']);
    check('a link out of the named directory is refused', code === 2, String(code));
    check('the refusal says nothing about the file it did not read', stdout === '',
      stdout.slice(0, 60));
    check('the refusal names a reason from the gate', /link|root|outside|symlink/i.test(stderr),
      stderr.split('\n')[0]);
  }

  // --- 2d. the one status that has two exit codes ----------------------------
  //
  // blocking_findings with complete coverage exits 0, and with incomplete
  // coverage exits 4: an inspection that did not look everywhere is a partial
  // inspection regardless of what it did find. No fixture is both at once, so
  // the pair that the table calls out was a claim about a branch nothing
  // reached. This document carries an embedded file, which blocks, and an
  // image, which leaves the OCR gap open.
  const both = join(scratch, 'blocking-and-incomplete.pdf');
  writeFileSync(both, buildBlockingIncompletePdf());
  {
    const { stdout, code } = run(['inspect', both, '--json']);
    const result = JSON.parse(stdout);
    check('a blocking finding with a gap is still blocking',
      result.status === 'blocking_findings', result.status);
    check('a blocking run that did not look everywhere exits 4', code === 4,
      `${result.status} exited ${code}`);
    const complete = run(['inspect', join(filesDir, 'embedded-file.positive.pdf'), '--json']);
    check('a blocking run that looked everywhere exits 0',
      JSON.parse(complete.stdout).status === 'blocking_findings' && complete.code === 0,
      String(complete.code));
  }

  // The spelling on disk, not the one that was typed. APFS folds case, so
  // report.pdf and Report.pdf are one file - and the path in the result is what
  // an agent will quote back to a person or hand to the next tool, so it has to
  // be the file's own name.
  {
    const cased = mkdtempSync(join(tmpdir(), 'beforeshare-case-'));
    writeFileSync(join(cased, 'Report.pdf'), readFileSync(join(filesDir, 'form-fields.positive.pdf')));
    const { stdout, code } = run(['inspect', join(cased, 'report.pdf'), '--json']);
    if (code === 0) {
      check('a result names the file as the disk spells it',
        JSON.parse(stdout).input.path.endsWith('/Report.pdf'), JSON.parse(stdout).input.path);
    } else {
      // A case-sensitive volume is the other legitimate answer, and it is a
      // refusal rather than a different file.
      check('on a case-sensitive volume the other spelling is refused', code === 2, String(code));
    }
  }

  // Pass literal .. to the CLI rather than normalising it inside this test.
  // This resolves back to an explicitly selected file; it is not an escape
  // from an independently authorised root. Fixed-root escape tests live in core.
  {
    const path = `${scratch}/../${scratch.split('/').pop()}/notes.txt`;
    const { stdout, code } = run(['inspect', path, '--json']);
    check('a literal parent component resolving to the selected file is handled', code === 3, String(code));
    check('the selected text file remains unsupported', JSON.parse(stdout).status === 'unsupported');
  }

  // --- 3. arguments ----------------------------------------------------------
  {
    const { stdout, stderr, code } = run(['--help']);
    check('top-level --help exits successfully', code === 0);
    check('help explains inspect without producing a JSON result',
      stdout === '' && stderr.includes('inspect <path>'));
  }
  {
    // Opening a directory succeeds on supported POSIX hosts; reading its bytes
    // fails. This exercises the post-gate I/O branch, even when tests run as root.
    const { stdout, stderr, code } = run(['inspect', scratch, '--json']);
    check('a read failure is processing failure, not invalid arguments', code === 5);
    check('a read failure emits no success result or sensitive path',
      stdout === '' && stderr.includes('could not read') && !stderr.includes(scratch));
  }
  for (const [label, args] of [
    ['an unknown command', ['frobnicate']],
    ['an unknown option', ['inspect', 'x.pdf', '--recursive']],
    ['inspect with no path', ['inspect']],
    ['inspect with two paths', ['inspect', 'a.pdf', 'b.pdf']],
    ['a path that does not exist', ['inspect', join(scratch, 'nope.pdf')]],
  ]) {
    const { stdout, stderr, code } = run(args);
    check(`${label} exits 2`, code === 2, String(code));
    check(`${label} puts nothing on stdout`, stdout === '', JSON.stringify(stdout.slice(0, 60)));
    check(`${label} says why on stderr`, stderr.trim().length > 0);
  }

  // --- 4. the other two commands ---------------------------------------------
  {
    const { stdout, code } = run(['capabilities', '--json']);
    const declaration = JSON.parse(stdout);
    check('capabilities validates against its schema', validateCapabilities(declaration),
      (validateCapabilities.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join('; '));
    check('capabilities exits 0', code === 0);
    // The declaration is published by this build, so it has to describe this
    // build: it said canInspect false while the detectors were running.
    check('capabilities says this build can inspect', declaration.operational.canInspect === true);
    for (const format of declaration.formats) {
      if (format.testedLimits.status === 'not_established') {
        check(`${format.mediaType}: unmeasured limits use a format-neutral explanation`,
          format.testedLimits.reason.startsWith('No limit has been measured on a reference machine: '));
      }
    }
    const registry = JSON.parse(readFileSync(join(schemaDir, 'detector-registry.json'), 'utf8'));
    const implemented = Object.entries(registry.detectors)
      .filter(([, d]) => d.status === 'implemented').map(([id]) => id).sort();
    const declared = declaration.formats
      .flatMap((f) => f.detectors.filter((d) => d.status === 'implemented').map((d) => d.id))
      .sort();
    check('every implemented detector is in the published declaration',
      JSON.stringify([...new Set(declared)]) === JSON.stringify(implemented),
      `${declared.join(',')} vs ${implemented.join(',')}`);
  }
  {
    const { stdout, code } = run(['version', '--json']);
    const version = JSON.parse(stdout);
    check('version reports the core it is running', typeof version.core === 'string'
      && version.core.length > 0 && typeof version.cli === 'string');
    check('version exits 0', code === 0);
  }
  {
    // §12.1: human-readable is the default. Not the same bytes as --json, and
    // not empty.
    const subject = join(filesDir, 'form-fields.positive.pdf');
    const human = run(['inspect', subject]);
    check('the default output is not JSON', !human.stdout.trim().startsWith('{'),
      human.stdout.slice(0, 40));
    check('the default output says something', human.stdout.trim().length > 0);
    check('the JSON notice explicitly preserves masking',
      human.stdout.includes('--json for the complete structured result; sensitive values remain masked.'));

    // The severity a person reads is the severity in the result. Two renderings
    // of one finding that disagree about how bad it is would make the default
    // output its own opinion.
    const asJson = JSON.parse(run(['inspect', subject, '--json']).stdout);
    const inJson = asJson.findings.map((f) => f.severity).sort();
    const inHuman = [...human.stdout.matchAll(/^ {2}\[([a-z]+)\]/gm)].map((m) => m[1]).sort();
    check('the severities shown match the severities in the result',
      JSON.stringify(inHuman) === JSON.stringify(inJson),
      `${inHuman.join(',')} vs ${inJson.join(',')}`);
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  cli: ${fixtures.length} fixtures, ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}
