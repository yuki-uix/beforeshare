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
export function identityKey(path, { caseInsensitive = IDENTITY.caseInsensitiveDefault } = {}) {
  let key = path.normalize(IDENTITY.unicodeNormalization);
  if (caseInsensitive) key = key.toLowerCase();
  return key;
}

export function sameFile(a, b, opts) {
  return identityKey(a, opts) === identityKey(b, opts);
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
export function createGate({ fs, authorisedRoots, caseInsensitive }) {
  // §13.4's root check is an authorisation decision, so it has to match how the
  // filesystem actually compares names. Folding case on a case-sensitive volume
  // would let /ROOT/secret count as inside /root. APFS is case-insensitive by
  // default but can be formatted either way, so this is probed, not assumed.
  // Probed per root, not once. Roots can sit on volumes with different rules,
  // and one rule applied to all of them takes an authorisation decision with the
  // wrong comparison for some. Until the API can carry a rule per root, a mixed
  // set is refused rather than silently resolved to one of them.
  // A handle is only issued when the matching access exists. Keying both off
  // `open` alone let a filesystem with open() but no readHandle() receive a
  // handle it could not use: the access took the handle branch, called a missing
  // method, and crashed — neither using the handle nor falling back to the path.
  const canReadHandle = typeof fs.open === 'function' && typeof fs.readHandle === 'function';
  const canWriteHandle = typeof fs.open === 'function' && typeof fs.writeHandle === 'function';

  const probe = (root) => (typeof fs.isCaseInsensitive === 'function'
    ? fs.isCaseInsensitive(root)
    : IDENTITY.caseInsensitiveDefault);
  let folding;
  if (caseInsensitive !== undefined) {
    folding = caseInsensitive;
  } else {
    const perRoot = authorisedRoots.map((r) => probe(r));
    if (new Set(perRoot).size > 1) {
      throw new Error(
        'authorised roots span volumes with different case rules; '
        + 'one comparison cannot be correct for all of them',
      );
    }
    folding = perRoot[0];
  }
  const key = (p) => identityKey(p, { caseInsensitive: folding });
  const same = (a, b) => sameFile(a, b, { caseInsensitive: folding });
  if (!Array.isArray(authorisedRoots) || authorisedRoots.length === 0) {
    // §13.4: the server must not request unrestricted filesystem access. A gate
    // with no roots would authorise everything, so it is not constructible.
    throw new Error('a gate requires at least one authorised root');
  }
  // The filesystem contract, checked here rather than discovered at the first
  // path that happens to need a member. `readlink` was added after a dangling
  // link turned out to be an authorisation bypass, and five stubs written
  // against the older three-member shape then failed one path at a time, each
  // with an error naming the path rather than the object that was wrong.
  const REQUIRED_FS = ['realpath', 'readlink', 'isDirectory'];
  const absent = REQUIRED_FS.filter((m) => typeof fs?.[m] !== 'function');
  if (absent.length > 0) {
    throw new Error(`this filesystem cannot answer what the gate must ask: missing ${absent.join(', ')}`);
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
  const roots = normalisedRoots.map(key);

  const withinRoots = (resolved) => {
    const k = key(resolved);
    return roots.some((root) => k === root || k.startsWith(root.endsWith('/') ? root : `${root}/`));
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
    // An output path names a file that does not exist yet, so ENOENT is ordinary
    // — but the lexical path is NOT a safe stand-in for it. If a parent
    // component is a link out of the authorised area, checking the lexical path
    // authorises a write that lands somewhere else entirely. So the nearest
    // existing ancestor is resolved and the missing tail appended to its real
    // location, and that is what gets checked.
    const target = resolveThroughMissingTail(fs, collapsed);
    const real = target === collapsed ? maybeRealpath(fs, collapsed) : target;

    if (real !== null && !same(real, collapsed) && !withinRoots(real)) {
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
      // A handle is taken here, while the path is the one that was checked.
      // Passing the string to the read would let a component be replaced between
      // the check and the open — the window is small, but §13.4's guarantee is
      // about where the bytes come from, not about where they came from a moment
      // ago. A filesystem without open() gets the old behaviour and says so.
      const handle = canReadHandle ? fs.open(path, 'read') : undefined;
      return issue({ path, mode: 'read', handle });
    },

    /**
     * @param {string} raw
     * @param {object} opts  { input } — the ResolvedPath being sanitized, so the
     *                       output is refused when it names the same file under
     *                       any spelling (§12.1); or an explicit null for a
     *                       write that is not derived from an input at all.
     *
     * The key is required. It used to default to "no input", which is the same
     * shape as forgetting it, and forgetting it meant §12.1's refusal quietly
     * did not run - a caller could resolve the original for writing and
     * overwrite it, which is the one thing §5.2 and §17.3 do not allow. A
     * default that can be reached by omission is not a decision.
     */
    forWrite(raw, opts) {
      if (!opts || !('input' in opts)) {
        throw new Error('forWrite needs { input } — the ResolvedPath being '
          + 'sanitized, or null to state that this write is not derived from one');
      }
      const { input } = opts;
      const path = resolve(raw);
      // Only null states "not derived from an input". undefined passes the key
      // check and would skip the refusal below, which is the same hole the
      // optional parameter had - reached now by forwarding a missing optional
      // argument instead of by omitting the key.
      if (input !== null) {
        assertResolved(input);
        if (same(path, input.path)) {
          throw new Rejected('output_is_input', path);
        }
      }
      if (fs.isDirectory(path)) {
        throw new Rejected('output_is_directory', path);
      }
      const handle = canWriteHandle ? fs.open(path, 'write') : undefined;
      return issue({ path, mode: 'write', handle });
    },
  };
}

function issue(value) {
  Object.freeze(value);
  issued.add(value);
  return value;
}

function maybeRealpath(fs, path) {
  try {
    return fs.realpath(path);
  } catch (e) {
    if (e?.code === 'ELOOP') throw new Rejected('symlink_loop', path);
    if (e?.code !== 'ENOENT') throw new Rejected('unresolvable', `${path}: ${e?.code ?? e?.message}`);
    return null;
  }
}

/**
 * Resolve as much of the path as exists, then append what does not.
 *
 * `realpath` on a path whose leaf is absent throws ENOENT and tells us nothing
 * about the directories above it. Treating the lexical path as the answer is an
 * authorisation bypass: `<root>/link/new.pdf`, where `link` points outside the
 * root, is lexically inside and actually is not.
 */
/**
 * The link target if this path is a symlink, null if it is not one.
 *
 * Mirrors `node:fs.readlinkSync`, which throws EINVAL for a path that exists
 * and is not a link, and ENOENT for one that is not there at all. Both mean the
 * same thing here: keep walking.
 */
function maybeReadlink(fs, path) {
  try {
    return fs.readlink(path);
  } catch (e) {
    if (e?.code === 'EINVAL' || e?.code === 'ENOENT') return null;
    throw new Rejected('unresolvable', `${path}: ${e?.code ?? e?.message}`);
  }
}

function resolveThroughMissingTail(fs, path, depth = 0) {
  if (depth > 40) throw new Rejected('symlink_loop', path);
  const segments = path.split('/').filter(Boolean);
  const missing = [];
  for (let i = segments.length; i >= 0; i -= 1) {
    const candidate = `/${segments.slice(0, i).join('/')}`;
    // A dangling symlink throws ENOENT too, and rejoining its own name to the
    // resolved parent discarded the link: a link pointing anywhere outside was
    // authorised under its in-root name, and the write landed at the target.
    // That is the bypass the loop below exists to close, reached through a link
    // that has no target rather than through one that does.
    const target = maybeReadlink(fs, candidate);
    if (target !== null) {
      const absolute = target.startsWith('/')
        ? target
        : `${candidate.slice(0, candidate.lastIndexOf('/'))}/${target}`;
      const { path: collapsed, escaped } = normalizeSegments(absolute);
      if (escaped) throw new Rejected('traversal', absolute);
      const resolved = resolveThroughMissingTail(fs, collapsed, depth + 1);
      return missing.length === 0 ? resolved : `${resolved}/${missing.join('/')}`;
    }
    const real = maybeRealpath(fs, candidate);
    if (real !== null) {
      return missing.length === 0 ? real : `${real === '/' ? '' : real}/${missing.join('/')}`;
    }
    if (i > 0) missing.unshift(segments[i - 1]);
  }
  // Not even `/` resolves. A filesystem that cannot answer for its own root has
  // not told us where this path goes.
  throw new Rejected('unresolvable', `${path}: no ancestor could be resolved`);
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
  if (resolved.handle !== undefined) return fs.readHandle(resolved.handle);
  return fs.read(resolved.path);
}

export function writeFile(fs, resolved, bytes) {
  assertResolved(resolved);
  if (resolved.mode !== 'write') throw new Error('this path was resolved for reading');
  if (resolved.handle !== undefined) return fs.writeHandle(resolved.handle, bytes);
  return fs.write(resolved.path, bytes);
}

/**
 * Whether this build closes the window between check and use.
 *
 * A filesystem without open()/readHandle() falls back to passing the checked
 * path, which re-resolves at access time: a component replaced in between is
 * followed. Callers that need the guarantee can ask instead of assuming.
 */
export function bindsToHandles(fs) {
  return typeof fs.open === 'function'
    && typeof fs.readHandle === 'function'
    && typeof fs.writeHandle === 'function';
}

export { Rejected };
