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

/** Every string anywhere in a parsed result, keys included: a value can hide in either. */
function stringsIn(node) {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(stringsIn);
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([key, value]) => [key, ...stringsIn(value)]);
  }
  return [];
}

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
    // Named, not counted. A hardcoded 24 reported "24 != 25" when a fixture was
    // added and could not say which one was missing - and the loop below only
    // walks results, so a fixture with no result at all was invisible to
    // everything except that number.
    const expected = Object.keys(manifest.fixtures)
      .map((f) => f.replace(/\.pdf$/, '.json')).sort();
    const missing = expected.filter((f) => !files.includes(f));
    check('every fixture produced a result', missing.length === 0, missing.join(', '));

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

        // The document's own values, nowhere in the result. Every category has
        // a masking policy and the policy was applied to the evidence and to
        // nothing else: a location carried a field name in full, and a whole
        // script went out under the one policy that shows a value unmasked.
        // Checking the values rather than the fields means the next exit fails
        // here instead of in a review.
        // The parsed strings, not the serialised text. Searching the JSON
        // source made this blind to exactly the value it was written for:
        // app.alert("phoning home"); is spelled with \" once serialised, so a
        // result carrying that script in full matched nothing and passed. A
        // check that cannot see the case it exists for is worse than none.
        const leaked = (entry.mustNotLeak ?? []).filter((v) => stringsIn(result).some((s) => s.includes(v)));
        check(`${file} carries none of its document's values verbatim`,
          leaked.length === 0, leaked.map((v) => JSON.stringify(v)).join(', '));
      }
    }
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  emitted results: ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}
