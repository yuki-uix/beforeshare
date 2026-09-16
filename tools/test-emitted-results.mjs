/**
 * The results the core emits, against the schema and against the fixtures'
 * own expectations.
 *
 * The core cannot check this for itself: a Rust assertion that its output
 * "looks right" would be the code checking its own idea of the shape. These are
 * validated by the same Ajv instance that validates the hand-written examples,
 * so the two implementations are held to one schema by one tool.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const schemaDir = join(root, 'schemas', 'v1');
const resultsDir = join(root, 'fixtures', 'pdf', 'results');

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  let failures = 0;
  const check = (name, ok, detail = '') => {
    if (ok) console.log(`ok    ${name}`);
    else { failures += 1; console.error(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
  };

  check('the core has emitted results to check', existsSync(resultsDir));
  if (existsSync(resultsDir)) {
    const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
    addFormats(ajv);
    for (const f of readdirSync(schemaDir).filter((f) => f.endsWith('.schema.json'))) {
      ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, f), 'utf8')), f);
    }
    const validate = ajv.getSchema('inspection-result.schema.json');

    const manifest = JSON.parse(readFileSync(join(root, 'fixtures/pdf/manifest.json'), 'utf8'));
    const files = readdirSync(resultsDir).filter((f) => f.endsWith('.json')).sort();
    check('every fixture produced a result', files.length === 24, `${files.length} results`);

    for (const file of files) {
      const result = JSON.parse(readFileSync(join(resultsDir, file), 'utf8'));
      check(`${file} validates against inspection-result.schema.json`,
        validate(result),
        (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join('; '));

      // The fixture says what it expects. A result that validates and disagrees
      // with its own fixture is a result nobody asked for.
      const fixture = `${file.replace(/\.json$/, '')}.pdf`;
      const entry = manifest.fixtures[fixture];
      check(`${file} names a fixture the manifest knows`, Boolean(entry), fixture);
      if (entry) {
        check(`${file} has the status its fixture expects`,
          result.status === entry.expectedStatus,
          `expected ${entry.expectedStatus}, got ${result.status}`);
      }
    }
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  emitted results: ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}
