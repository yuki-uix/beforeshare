/**
 * Reference implementation of the path safety gate (§13.4, §12.1).
 *
 * The point of this module is not the checks — those are ordinary — but that
 * there is no way around them. `readFile` and `writeFile` here accept only a
 * ResolvedPath, and a ResolvedPath can only be produced by the gate, because its
 * brand is a symbol this module never exports. A caller holding a plain string
 * cannot reach the filesystem, so "forgetting to call the gate" is not a mistake
 * review has to catch.
 *
 * That property is what §13.4 needs. "Symlinks and path traversal must be
 * resolved and checked before access or writing" is a statement about every
 * access, and a rule applied at every call site is a rule that eventually is not.
 *
 * The filesystem is injected rather than imported so the conformance vectors can
 * describe symlink layouts that would be awkward, and on some machines
 * impossible, to create on disk.
 */
import { readFileSync } from 'node:fs';

const RULES = JSON.parse(
  readFileSync(new URL('../schemas/v1/path-rules.json', import.meta.url), 'utf8'),
);

export const REJECTION_REASONS = Object.keys(RULES.rejectionReasons);
export const IDENTITY = RULES.identity;

/**
 * Membership, not a property.
 *
 * The brand was first a symbol on the object. Object spread copies symbol keys,
 * so `{ ...readPath, mode: 'write' }` carried the brand and turned a read
 * authorisation into a write one — the exact substitution `mode` exists to
 * prevent. A WeakSet records which objects this module produced; a copy is a
 * different object and is not in it.
 */
const issued = new WeakSet();

/**
 * The comparison that decides whether two paths name one file.
 *
 * Case folding and NFC normalisation are both required on macOS: APFS is
 * case-insensitive by default, and a filename an application spells NFC is
 * stored NFD. Comparing raw strings would let two spellings of one file look
 * like two files — which is how an output path ends up on its input.
 */
export function identityKey(path) {
  let key = path.normalize(IDENTITY.unicodeNormalization);
  if (IDENTITY.caseInsensitive) key = key.toLowerCase();
  return key;
}

export function sameFile(a, b) {
  return identityKey(a) === identityKey(b);
}

class Rejected extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
    this.detail = detail;
    if (!REJECTION_REASONS.includes(reason)) {
      throw new Error(`unlisted rejection reason: ${reason}`);
    }
  }
}

/** Collapse `.` and `..` without touching the filesystem. */
function normalizeSegments(path) {
  const out = [];
  let escaped = false;
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) escaped = true;
      else out.pop();
      continue;
    }
    out.push(seg);
  }
  return { path: `/${out.join('/')}`, escaped };
}

/**
 * @param {object} fs  { realpath(path): string, isDirectory(path): boolean }
 *                     realpath mirrors node:fs — it THROWS rather than returning
 *                     null, with `code` ENOENT when the path does not exist and
 *                     ELOOP on a cycle of links. Writing it as "returns null on
 *                     absence" would have been a contract no real filesystem
 *                     honours, and every vector ran against the stub that did.
 */
export function createGate({ fs, authorisedRoots }) {
  if (!Array.isArray(authorisedRoots) || authorisedRoots.length === 0) {
    // §13.4: the server must not request unrestricted filesystem access. A gate
    // with no roots would authorise everything, so it is not constructible.
    throw new Error('a gate requires at least one authorised root');
  }
  // A relative root is a configuration error that would otherwise fail silently:
  // the gate constructs, and then every path is refused as outside it. The error
  // would point at the path rather than at the root that is actually wrong.
  const relative = authorisedRoots.filter((r) => typeof r !== 'string' || !r.startsWith('/'));
  if (relative.length > 0) {
    throw new Error(`authorised roots must be absolute: ${relative.join(', ')}`);
  }
  const normalisedRoots = authorisedRoots.map((r) => normalizeSegments(r).path);
  // Nor by naming the filesystem root. An empty list and ['/'] authorise exactly
  // the same thing; refusing only the first would leave the rule satisfiable by
  // spelling.
  const wide = normalisedRoots.filter((r) => r === '/');
  if (wide.length > 0) {
    throw new Error('the filesystem root is not an authorised root: §13.4 forbids unrestricted access');
  }
  const roots = normalisedRoots.map(identityKey);

  const withinRoots = (resolved) => {
    const key = identityKey(resolved);
    return roots.some((root) => key === root || key.startsWith(root.endsWith('/') ? root : `${root}/`));
  };

  const resolve = (raw) => {
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new Rejected('empty_or_null_byte', 'path is empty');
    }
    if (raw.includes('\0')) {
      throw new Rejected('empty_or_null_byte', 'path contains a NUL byte');
    }
    if (!raw.startsWith('/')) {
      throw new Rejected('not_absolute', raw);
    }

    const { path: collapsed, escaped } = normalizeSegments(raw);
    if (escaped) throw new Rejected('traversal', raw);

    // Dereference before deciding anything else: a link in any component can
    // move the target, and the check has to run on where the path actually goes.
    let real = null;
    try {
      real = fs.realpath(collapsed);
    } catch (e) {
      // Absence is ordinary — an output path names a file that does not exist
      // yet — so it falls through to the root check on the collapsed path.
      // Anything else is the filesystem telling us it cannot answer, and a gate
      // that cannot resolve a path has not checked it.
      if (e?.code === 'ELOOP') throw new Rejected('symlink_loop', collapsed);
      if (e?.code !== 'ENOENT') throw new Rejected('unresolvable', `${collapsed}: ${e?.code ?? e?.message}`);
    }
    const target = real ?? collapsed;

    if (real !== null && !sameFile(real, collapsed) && !withinRoots(real)) {
      throw new Rejected('symlink_escape', `${collapsed} -> ${real}`);
    }
    if (!withinRoots(target)) {
      throw new Rejected('outside_authorised_roots', target);
    }
    return target;
  };

  return {
    /** @returns {{[RESOLVED]: true, path: string}} */
    forRead(raw) {
      const path = resolve(raw);
      return issue({ path, mode: 'read' });
    },

    /**
     * @param {string} raw
     * @param {object} opts  { input: ResolvedPath } — the file being sanitized,
     *                       so the output can be refused when it names the same
     *                       file under any spelling (§12.1).
     */
    forWrite(raw, { input } = {}) {
      const path = resolve(raw);
      if (input !== undefined) {
        assertResolved(input);
        if (sameFile(path, input.path)) {
          throw new Rejected('output_is_input', path);
        }
      }
      if (fs.isDirectory(path)) {
        throw new Rejected('output_is_directory', path);
      }
      return issue({ path, mode: 'write' });
    },
  };
}

function issue(value) {
  Object.freeze(value);
  issued.add(value);
  return value;
}

function assertResolved(value) {
  if (!value || typeof value !== 'object' || !issued.has(value)) {
    // Reachable only by constructing the object by hand, which is the mistake
    // this module exists to make visible rather than silent.
    throw new Error('this path did not come from the gate');
  }
  return value;
}

/** File access takes a ResolvedPath, never a string. */
export function readFile(fs, resolved) {
  assertResolved(resolved);
  if (resolved.mode !== 'read') throw new Error('this path was resolved for writing');
  return fs.read(resolved.path);
}

export function writeFile(fs, resolved, bytes) {
  assertResolved(resolved);
  if (resolved.mode !== 'write') throw new Error('this path was resolved for reading');
  return fs.write(resolved.path, bytes);
}

export { Rejected };
