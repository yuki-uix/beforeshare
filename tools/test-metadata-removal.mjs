/** Real Rust metadata transformation plus canonical action-result validation. */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
const root = fileURLToPath(new URL('../', import.meta.url));
function cargo(args) {
  const result = spawnSync('cargo', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 24 });
  if (result.error || result.status !== 0) throw new Error(result.error ?? `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const tests = cargo(['test', '-p', 'beforeshare-core', '--lib', 'pdf_metadata::tests::']);
const passed = [...tests.matchAll(/^test pdf_metadata::tests::([^ ]+) \.\.\. ok$/gm)];
if (passed.length < 12) throw new Error('Metadata tests were empty or incomplete');
for (const [, name] of passed) console.log(`ok    Rust ${name}`);
const action = JSON.parse(cargo(['run', '-q', '-p', 'beforeshare-core', '--example', 'metadata-readback']));
const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
addFormats(ajv);
const schemas = new URL('../schemas/v1/', import.meta.url);
for (const file of readdirSync(schemas).filter((f) => f.endsWith('.schema.json'))) {
  ajv.addSchema(JSON.parse(readFileSync(new URL(file, schemas), 'utf8')), file);
}
const validate = ajv.compile({ $ref: 'https://beforeshare.dev/schemas/v1/verification-result.schema.json#/$defs/actionResult' });
if (!validate(action)) throw new Error(ajv.errorsText(validate.errors));
console.log('ok    actual Rust metadata readback validates against the canonical actionResult');
if (action.outcome !== 'unable_to_verify' || action.unverifiableReason !== 'no_independent_reader_for_this_action'
    || action.surfacesChecked.length || action.readPaths.some((path) => path.role !== 'shares_writer_implementation' || 'surface' in path)) {
  throw new Error('A shared-parser readback claimed independent success or coverage');
}
console.log('ok    a published copy remains unverified without an independent reader');
const fakeSuccess = structuredClone(action);
fakeSuccess.outcome = 'verified_removed';
delete fakeSuccess.unverifiableReason;
fakeSuccess.surfacesChecked = ['metadata_block'];
fakeSuccess.readPaths[0].surface = 'metadata_block';
if (validate(fakeSuccess)) throw new Error('Canonical schema accepted shared-parser success');
console.log('ok    canonical schema rejects promotion of shared readback to verified removal');
console.log(`\nPASS  ${passed.length} actual Rust metadata checks and emitted action-result contract`);
