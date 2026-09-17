/**
 * The command line, run as a process.
 *
 * Everything here goes through the binary. A test that called the core would
 * prove the core works, which other suites already do; what is unproven until
 * a process runs is that the exit code, stdout and stderr agree with each other
 * and with the result - #24 left exactly that here, because it needs a real
 * process to be true or false about.
 */
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { run } from './cli-adapter.mjs';
import { STATUS_EXIT_MATRIX } from './exit-codes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const schemaDir = join(root, 'schemas', 'v1');
const filesDir = join(root, 'fixtures', 'pdf', 'files');

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

  // Both halves of the one status that has two codes. Without this the pair is
  // a claim about a branch nothing reached.
  check('a complete run and an incomplete one produced different codes',
    seenCodes.has(0) && seenCodes.has(4), [...seenCodes].join(', '));

  // --- 2. what is outside the supported set ----------------------------------
  const scratch = mkdtempSync(join(tmpdir(), 'beforeshare-cli-'));
  const notPdf = join(scratch, 'notes.txt');
  writeFileSync(notPdf, 'this is not a PDF, whatever the name says');
  {
    const { stdout, code } = run(['inspect', notPdf, '--json']);
    const result = JSON.parse(stdout);
    check('an unsupported input is unsupported, not failed', result.status === 'unsupported',
      result.status);
    check('an unsupported input exits 3', code === 3, String(code));
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

  // --- 3. arguments ----------------------------------------------------------
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
    const human = run(['inspect', join(filesDir, 'form-fields.positive.pdf')]);
    check('the default output is not JSON', human.stdout.trim().startsWith('/')
      || !human.stdout.trim().startsWith('{'), human.stdout.slice(0, 40));
    check('the default output says something', human.stdout.trim().length > 0);
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  cli: ${fixtures.length} fixtures, ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}
