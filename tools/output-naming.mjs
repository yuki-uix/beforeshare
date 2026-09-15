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
import { WriteFailed, classify } from './failure-semantics.mjs';
import { TEMP_MODE } from './temp-files.mjs';

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
 * @param {object} fs            needs createExclusive(path, { mode }): true, or false if taken
 * @param {object} gate          the path gate; every candidate goes through it
 * @param {object} input         the ResolvedPath being sanitized
 * @param {object} [opts]        { explicitPath } from §12.1's explicit output path
 */
export function claimOutputPath(fs, gate, input, { explicitPath } = {}) {
  const directory = dirnameOf(input.path);
  const candidates = [];
  if (explicitPath !== undefined) {
    // An explicit path says where to write. It does not say "replace what is
    // there": §9.3 forbids that, and a user naming a file they forgot about is
    // the case the rule exists for. One candidate and no fallback - writing
    // beside the name someone chose would be its own surprise.
    candidates.push(gate.forWrite(explicitPath, { input }));
  } else {
    const fileName = basenameOf(input.path);
    for (let n = 1; n <= NAMING.maxAttempts; n += 1) {
      candidates.push(gate.forWrite(`${directory}/${candidateName(fileName, n)}`, { input }));
    }
  }

  // The reservation is the temporary file, not the destination.
  //
  // Reserving the destination with an empty placeholder and renaming over it
  // later cannot be made safe without handles: between the placeholder and the
  // rename another process can delete it and put its own file there, and an
  // ordinary rename replaces that file without noticing. Re-reading the path
  // first only narrows the window. So the destination is never created early -
  // it comes into existence at publish, by a link that refuses to replace.
  // Each candidate has its own temporary name, and the first one this process
  // can create is the reservation. Tying the temporary file to the first
  // candidate alone meant a second run could not start at all while the first
  // was still writing - its temporary name was taken and every free name behind
  // it was unreachable, which is the concurrent case in §20.2 failing in the
  // other direction.
  for (let i = 0; i < candidates.length; i += 1) {
    const temp = gate.forWrite(`${candidates[i].path}.part`, { input });
    // Owner-only, and at creation. Creating it readable and narrowing it after
    // leaves it world-readable for the interval between, which is the whole of
    // the window someone waiting for it needs. The mode is passed, not assumed:
    // an adapter that ignores it is a different defect, and one the vectors
    // check against a real filesystem.
    if (fs.createExclusive(temp.path, { mode: TEMP_MODE })) {
      return issueClaim(candidates.slice(i), temp, input);
    }
  }
  if (candidates.length === 1) {
    throw new OutputRejected('temp_name_taken', `${candidates[0].path}.part belongs to another run`);
  }
  throw new OutputRejected('no_free_name',
    `${NAMING.maxAttempts} names beside ${basenameOf(input.path)} are busy`);
}

function issueClaim(candidates, temp, input) {
  const claim = Object.freeze({
    path: candidates[0].path,   // where it lands if nothing takes the name first
    candidates: Object.freeze(candidates),
    temp,
    input,
  });
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
export function writeClaimed(fs, gate, claim, bytes, { cancellation } = {}) {
  if (!claim || typeof claim !== 'object' || !claims.has(claim)) {
    throw new Error('writing needs a claim from claimOutputPath()');
  }
  const stop = cancellation?.throwIfCancelled?.bind(cancellation) ?? (() => {});

  // One place releases the reservation, for every way out. Releasing it beside
  // each throw missed the cancellations, because those are raised outside the
  // block that catches filesystem errors - so every cancelled run consumed a
  // destination name for good, which is the accumulation this is here to stop.
  try {
    // The interruption points are named, and each one is asked. A run that only
    // checks before starting and after finishing answers a cancel with the
    // whole job still to do, which §17.4 would measure as the worst latency the
    // build can produce.
    stop('after_reserve');
    try {
      writeFile(fs, claim.temp, bytes);
    } catch (e) {
      throw new WriteFailed(classify(e), `writing ${claim.temp.path}: ${e?.message ?? e}`);
    }
    stop('after_write');

    // Publish by linking, not by renaming. A link refuses an existing name, and
    // does so atomically, so a destination that appeared after the claim is
    // stepped over rather than replaced. A rename would have overwritten it -
    // §9.3's silent overwrite arriving through the back door.
    //
    // It is also what makes an interrupted run harmless: the destination comes
    // into existence in one step, after every byte is in the temporary file, so
    // there is no interval in which a partial file wears the finished name.
    for (const destination of claim.candidates) {
      let published = false;
      try {
        published = fs.link(claim.temp.path, destination.path);
      } catch (e) {
        throw new WriteFailed(classify(e), `publishing ${destination.path}: ${e?.message ?? e}`);
      }
      // Past this point the work is done. A cancel arriving now is answered by
      // the finished file, not by tearing it up - the user asked to stop, not
      // to lose what was already theirs.
      if (published) return destination.path;
      stop('during_publish');
    }
    if (claim.candidates.length === 1) {
      throw new OutputRejected('destination_exists', claim.candidates[0].path);
    }
    throw new OutputRejected('no_free_name',
      `${NAMING.maxAttempts} names beside ${basenameOf(claim.input.path)} were taken`);
  } finally {
    discard(fs, claim);
  }
}


/**
 * Remove the reservation, and never turn a failure into a different one.
 *
 * A cleanup that throws replaces the diagnosis with its own - the caller is
 * told the unlink failed and never hears about the disk being full. What the
 * unlink leaves behind still carries the incomplete marker, so it is debris
 * under a name nobody was told to look at rather than a result.
 */
function discard(fs, claim) {
  try { fs.unlink(claim.temp.path); } catch { /* the marker is the fallback */ }
}

export { OutputRejected };
