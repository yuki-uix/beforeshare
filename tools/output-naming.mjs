/**
 * Producing a sanitized file without touching the original.
 *
 * §5.2 makes originals immutable and §9.3 forbids in-place overwrite, so the
 * question this module answers is not "may we write here" but "which name did
 * we manage to reserve". The difference matters: asking whether a name is free
 * and then using it leaves a window in which another process asks the same
 * question and gets the same answer, which is the concurrent case §20.2
 * requires a test for.
 *
 * A reference implementation of the rules in schemas/v1/output-rules.json, not
 * the product runtime. The core language is still undecided.
 */
import { readFileSync } from 'node:fs';
import { writeFile } from './path-gate.mjs';

const RULES = JSON.parse(
  readFileSync(new URL('../schemas/v1/output-rules.json', import.meta.url), 'utf8'),
);

export const NAMING = RULES.naming;
export const OUTPUT_REJECTIONS = Object.keys(RULES.rejectionReasons);

class OutputRejected extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
  }
}

/** Names this process reserved by creating them. Writing needs one. */
const claims = new WeakSet();

/**
 * Split a name into the part the marker goes after and the extension.
 *
 * The marker sits before the final extension so the result still opens in the
 * application that opened the input - the point of §11.1's collision-safe
 * filenames. A leading dot is part of the name, not an extension: `.bashrc`
 * would otherwise become ` (sanitized).bashrc`, which names a different file.
 */
export function splitExtension(fileName) {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return { stem: fileName, extension: '' };
  return { stem: fileName.slice(0, dot), extension: fileName.slice(dot) };
}

/** The nth candidate name for an input, n starting at 1. */
export function candidateName(fileName, n) {
  const { stem, extension } = splitExtension(fileName);
  const sequence = n === 1
    ? ''
    : `${NAMING.sequenceSeparator}${NAMING.firstSequenceNumber + n - 2}`;
  return `${stem}${NAMING.marker}${sequence}${extension}`;
}

function dirnameOf(path) {
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '/' : path.slice(0, slash);
}

function basenameOf(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Reserve a destination beside the input, and hand back the only thing writing
 * accepts.
 *
 * @param {object} fs            needs createExclusive(path): true, or false if taken
 * @param {object} gate          the path gate; every candidate goes through it
 * @param {object} input         the ResolvedPath being sanitized
 * @param {object} [opts]        { explicitPath } from §12.1's explicit output path
 */
export function claimOutputPath(fs, gate, input, { explicitPath } = {}) {
  if (explicitPath !== undefined) {
    // An explicit path says where to write. It does not say "replace what is
    // there": §9.3 forbids that, and a user naming a file they forgot about is
    // the case the rule exists for.
    const resolved = gate.forWrite(explicitPath, { input });
    if (!fs.createExclusive(resolved.path)) {
      throw new OutputRejected('destination_exists', resolved.path);
    }
    return issueClaim(resolved, input);
  }

  const directory = dirnameOf(input.path);
  const fileName = basenameOf(input.path);
  for (let n = 1; n <= NAMING.maxAttempts; n += 1) {
    const candidate = `${directory}/${candidateName(fileName, n)}`;
    const resolved = gate.forWrite(candidate, { input });
    // Creating it IS the reservation. A free-name check followed by a write
    // would let two processes agree on the same answer.
    if (fs.createExclusive(resolved.path)) return issueClaim(resolved, input);
  }
  throw new OutputRejected('no_free_name',
    `${NAMING.maxAttempts} names beside ${fileName} were taken`);
}

function issueClaim(resolvedPath, input) {
  const claim = Object.freeze({ path: resolvedPath.path, resolvedPath, input });
  claims.add(claim);
  return claim;
}

/**
 * Write the sanitized bytes into a claimed name.
 *
 * Temp beside the destination, then rename: a rename is atomic within one
 * filesystem, and a half-written file wearing the destination's name is the one
 * thing §12.1 says must never appear.
 */
export function writeClaimed(fs, gate, claim, bytes, { tempPath } = {}) {
  if (!claim || typeof claim !== 'object' || !claims.has(claim)) {
    throw new Error('writing needs a claim from claimOutputPath()');
  }
  const temp = tempPath ?? `${claim.path}.part`;
  if (dirnameOf(temp) !== dirnameOf(claim.path)) {
    throw new OutputRejected('temp_outside_destination_directory',
      `${temp} is not beside ${claim.path}`);
  }
  // The temporary name is claimed the same way the destination is. Writing to
  // it unconditionally would destroy another run's half-written file, which is
  // the collision the destination is careful about, one name over.
  if (!fs.createExclusive(temp)) {
    throw new OutputRejected('temp_name_taken',
      `${temp} belongs to another run`);
  }
  // The temporary file is a path being written, so §13.4 applies to it exactly
  // as it does to the destination. It is a separate name from the one that was
  // checked, and a planted symlink at `<destination>.part` would otherwise be
  // followed - the bytes land wherever it points, and the rename then moves
  // something else into place.
  const resolvedTemp = gate.forWrite(temp, { input: claim.input });
  writeFile(fs, resolvedTemp, bytes);
  fs.rename(resolvedTemp.path, claim.path);
  return claim.path;
}

export { OutputRejected };
