#!/usr/bin/env node
/**
 * Conformance vectors for the path safety gate.
 *
 * Every vector calls tools/path-gate.mjs. The last check in this file requires
 * every rejection reason declared in path-rules.json to appear in at least one
 * vector, so adding a reason without a case that triggers it fails the build —
 * the reason being listed is not the same as it being reachable.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { createGate, readFile, writeFile, identityKey, sameFile, bindsToHandles, REJECTION_REASONS } from './path-gate.mjs';

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


const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  let failures = 0;
  const triggered = new Set();
  const check = (name, cond, detail) => {
    if (cond) console.log(`ok    ${name}`);
    else { failures += 1; console.error(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
  };

  /**
   * For assertions whose expression can throw.
   *
   * `check(name, gate().forRead(p).path === q)` evaluates its argument before
   * check runs, so a rejection escapes the suite entirely: the process dies with
   * a stack trace, no FAIL line is printed, and anything reading the output for
   * failures — the CI guard among them — sees none. A suite that can die instead
   * of failing reports nothing about the case it died on.
   */
  const checkOk = (name, fn, detail) => {
    try {
      check(name, fn() === true, detail);
    } catch (e) {
      failures += 1;
      console.error(`FAIL  ${name}\n        threw instead of returning: ${e.reason ?? e.message}`);
    }
  };

  /**
   * A filesystem described by a symlink map, so a layout needs no disk.
   *
   * It mirrors node:fs rather than a convenient shape: realpath throws with a
   * `code`, ENOENT for a path that is not in `exists`, and ELOOP on a cycle. An
   * earlier version returned null on absence and stopped silently after ten hops
   * — a contract no real filesystem honours, which every vector then ran against.
   */
  const err = (code) => Object.assign(new Error(code), { code });
  const stubFs = ({ links = {}, dirs = [], missing = [] } = {}) => ({
    realpath(p) {
      let cur = p;
      const seen = new Set();
      for (;;) {
        const hit = Object.keys(links).find((from) => cur === from || cur.startsWith(`${from}/`));
        if (!hit) break;
        if (seen.has(cur)) throw err('ELOOP');
        seen.add(cur);
        // A relative target resolves against the directory holding the link, not
        // against the process working directory and not as if it were absolute.
        // Treating it as absolute made the stub describe a filesystem that does
        // not exist, and the vectors agreed with it.
        const target = links[hit].startsWith('/')
          ? links[hit]
          : `${hit.slice(0, hit.lastIndexOf('/'))}/${links[hit]}`;
        const joined = cur === hit ? target : target + cur.slice(hit.length);
        cur = `/${joined.split('/').reduce((acc, seg) => {
          if (seg === '' || seg === '.') return acc;
          if (seg === '..') { acc.pop(); return acc; }
          acc.push(seg); return acc;
        }, []).join('/')}`;
      }
      if (missing.includes(cur)) throw err('ENOENT');
      return cur;
    },
    isDirectory: (p) => dirs.includes(p),
    read: () => 'bytes',
    write: () => true,
  });

  const ROOT = '/Users/u/Documents';
  const gate = (opts = {}) => createGate({ fs: stubFs(opts), authorisedRoots: [ROOT] });

  const rejects = (name, fn, expected) => {
    try {
      fn();
      check(name, false, `expected rejection ${expected}, got success`);
    } catch (e) {
      triggered.add(e.reason);
      check(name, e.reason === expected, `expected ${expected}, got ${e.reason ?? e.message}`);
    }
  };

  // --- absolute paths only ----------------------------------------------------
  rejects('a relative path is refused', () => gate().forRead('Documents/a.pdf'), 'not_absolute');
  rejects('an empty path is refused', () => gate().forRead(''), 'empty_or_null_byte');
  rejects('a NUL byte is refused', () => gate().forRead(`${ROOT}/a\0.pdf`), 'empty_or_null_byte');

  // --- traversal --------------------------------------------------------------
  rejects('a path escaping the root by .. is refused',
    () => gate().forRead(`${ROOT}/../../etc/passwd`), 'outside_authorised_roots');
  rejects('a path escaping above / is refused',
    () => gate().forRead('/../../etc/passwd'), 'traversal');
  checkOk('a .. that stays inside the root is allowed',
    () => gate().forRead(`${ROOT}/sub/../a.pdf`).path === `${ROOT}/a.pdf`);

  // --- symlinks ---------------------------------------------------------------
  rejects('a symlink leaving the root is refused',
    () => gate({ links: { [`${ROOT}/link.pdf`]: '/etc/passwd' } }).forRead(`${ROOT}/link.pdf`),
    'symlink_escape');
  rejects('a symlinked directory component leaving the root is refused',
    () => gate({ links: { [`${ROOT}/sub`]: '/private/tmp' } }).forRead(`${ROOT}/sub/a.pdf`),
    'symlink_escape');
  // §34 names relative targets explicitly. A relative link resolves against the
  // directory holding it, so the same spelling can stay inside or leave
  // depending on where the link lives.
  checkOk('a relative symlink staying inside the root is allowed',
    () => gate({ links: { [`${ROOT}/alias.pdf`]: 'real.pdf' } }).forRead(`${ROOT}/alias.pdf`).path
      === `${ROOT}/real.pdf`);
  rejects('a relative symlink escaping the root is refused',
    () => gate({ links: { [`${ROOT}/alias.pdf`]: '../../../etc/passwd' } }).forRead(`${ROOT}/alias.pdf`),
    'symlink_escape');
  rejects('a relative symlink in a directory component escaping the root is refused',
    () => gate({ links: { [`${ROOT}/sub`]: '../../../private/tmp' } }).forRead(`${ROOT}/sub/a.pdf`),
    'symlink_escape');

  // The bypass this gate was shipped with: a missing leaf under a link that
  // leaves the root. realpath throws ENOENT and says nothing about the parents,
  // so the lexical path looked inside while the write would land outside.
  rejects('a missing file under an escaping link is refused for writing',
    () => gate({ links: { [`${ROOT}/evil`]: '/private/tmp' }, missing: ['/private/tmp/new.pdf'] })
      .forWrite(`${ROOT}/evil/new.pdf`),
    'symlink_escape');

  checkOk('a symlink staying inside the root is allowed',
    () => gate({ links: { [`${ROOT}/link.pdf`]: `${ROOT}/real.pdf` } }).forRead(`${ROOT}/link.pdf`).path
      === `${ROOT}/real.pdf`);

  // --- authorised roots -------------------------------------------------------
  rejects('a path outside every authorised root is refused',
    () => gate().forRead('/etc/passwd'), 'outside_authorised_roots');
  rejects('a sibling directory sharing a name prefix is refused',
    () => gate().forRead('/Users/u/DocumentsOther/a.pdf'), 'outside_authorised_roots');
  let noRoots = false;
  try { createGate({ fs: stubFs(), authorisedRoots: [] }); } catch { noRoots = true; }
  check('a gate with no authorised roots cannot be constructed', noRoots);

  // ['/'] authorises exactly what [] would. Refusing only the empty list would
  // leave §13.4 satisfiable by spelling.
  let rootSlash = false;
  try { createGate({ fs: stubFs(), authorisedRoots: ['/'] }); } catch { rootSlash = true; }
  check('the filesystem root cannot be an authorised root', rootSlash);
  let rootSlashAmong = false;
  try { createGate({ fs: stubFs(), authorisedRoots: [ROOT, '/'] }); } catch { rootSlashAmong = true; }
  check('the filesystem root cannot hide among other roots', rootSlashAmong);

  // A relative root constructs a gate that refuses everything, and the refusal
  // names the path rather than the misconfigured root.
  let relRoot = false;
  try { createGate({ fs: stubFs(), authorisedRoots: ['Documents'] }); } catch { relRoot = true; }
  check('a relative authorised root is refused at construction', relRoot);

  checkOk('an authorised root is matched after normalisation',
    () => createGate({ fs: stubFs(), authorisedRoots: ['/Users/u/caf\u00e9'] })
      .forRead('/Users/u/cafe\u0301/a.pdf').path === '/Users/u/cafe\u0301/a.pdf');
  checkOk('an authorised root is matched case-insensitively',
    () => createGate({ fs: stubFs(), authorisedRoots: [ROOT] }).forRead('/USERS/U/DOCUMENTS/a.pdf').path
      === '/USERS/U/DOCUMENTS/a.pdf');

  checkOk('a root spelled with a trailing slash behaves the same',
    () => createGate({ fs: stubFs(), authorisedRoots: [`${ROOT}/`] }).forRead(`${ROOT}/a.pdf`).path === `${ROOT}/a.pdf`);
  checkOk('doubled separators collapse',
    () => gate().forRead(`${ROOT}//sub//..//a.pdf`).path === `${ROOT}/a.pdf`);

  // --- link cycles and unresolvable paths -------------------------------------
  rejects('a cycle of symlinks is refused',
    () => gate({ links: { [`${ROOT}/a`]: `${ROOT}/b`, [`${ROOT}/b`]: `${ROOT}/a` } }).forRead(`${ROOT}/a`),
    'symlink_loop');
  rejects('a filesystem that cannot answer is refused',
    () => createGate({
      fs: { realpath() { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); }, isDirectory: () => false },
      authorisedRoots: [ROOT],
    }).forRead(`${ROOT}/a.pdf`),
    'unresolvable');
  checkOk('a path that does not exist yet is allowed for writing',
    () => gate({ missing: [`${ROOT}/new.pdf`] }).forWrite(`${ROOT}/new.pdf`).path === `${ROOT}/new.pdf`);

  // Several missing levels at once. Walking back only one would stop at a
  // directory that also does not exist and learn nothing about the link above it.
  checkOk('a path several missing levels deep still resolves to its real ancestor',
    () => gate({ missing: [`${ROOT}/a`, `${ROOT}/a/b`, `${ROOT}/a/b/c.pdf`] })
      .forWrite(`${ROOT}/a/b/c.pdf`).path === `${ROOT}/a/b/c.pdf`);
  rejects('an escaping link several missing levels above the leaf is refused',
    () => gate({
      links: { [`${ROOT}/evil`]: '/private/tmp' },
      missing: ['/private/tmp/a', '/private/tmp/a/b', '/private/tmp/a/b/c.pdf'],
    }).forWrite(`${ROOT}/evil/a/b/c.pdf`),
    'symlink_escape');

  // --- output must not be the input (§12.1) -----------------------------------
  {
    const g = gate();
    const input = g.forRead(`${ROOT}/report.pdf`);
    rejects('an output equal to the input is refused',
      () => g.forWrite(`${ROOT}/report.pdf`, { input }), 'output_is_input');
    rejects('an output differing only in case is refused',
      () => g.forWrite(`${ROOT}/Report.PDF`, { input }), 'output_is_input');
    rejects('an output differing only in Unicode normalisation is refused',
      () => {
        const nfd = g.forRead(`${ROOT}/café.pdf`);
        return g.forWrite(`${ROOT}/café.pdf`, { input: nfd });
      }, 'output_is_input');
    rejects('an output reaching the input through .. is refused',
      () => g.forWrite(`${ROOT}/sub/../report.pdf`, { input }), 'output_is_input');
    rejects('an output reaching the input through a symlink is refused',
      () => {
        const gl = gate({ links: { [`${ROOT}/alias.pdf`]: `${ROOT}/report.pdf` } });
        return gl.forWrite(`${ROOT}/alias.pdf`, { input: gl.forRead(`${ROOT}/report.pdf`) });
      }, 'output_is_input');
    checkOk('a different output path is allowed',
      () => g.forWrite(`${ROOT}/report (sanitized).pdf`, { input }).path === `${ROOT}/report (sanitized).pdf`);
  }

  rejects('an output naming a directory is refused',
    () => gate({ dirs: [`${ROOT}/out`] }).forWrite(`${ROOT}/out`), 'output_is_directory');

  // --- the brand: a path that did not come from the gate reaches nothing -------
  {
    const fs = stubFs();
    let forged = false;
    try { readFile(fs, { path: '/etc/passwd', mode: 'read' }); } catch { forged = true; }
    check('a hand-built path object cannot be read', forged);

    let wrongMode = false;
    try { writeFile(fs, gate().forRead(`${ROOT}/a.pdf`), 'x'); } catch { wrongMode = true; }
    check('a path resolved for reading cannot be written', wrongMode);

    // Object spread copies symbol keys, so a brand held as a property travelled
    // with the copy and turned a read authorisation into a write one. Membership
    // does not copy.
    let spread = false;
    const readPath = gate().forRead(`${ROOT}/a.pdf`);
    try { writeFile(fs, { ...readPath, mode: 'write' }, 'x'); } catch { spread = true; }
    check('a copy of a resolved path is not a resolved path', spread);

    let mutated = false;
    try { readPath.path = '/etc/passwd'; mutated = readPath.path !== '/etc/passwd'; } catch { mutated = true; }
    check('a resolved path cannot be edited after issue', mutated);

    let nullPath = false;
    try { readFile(fs, null); } catch { nullPath = true; }
    check('a missing path is refused rather than treated as a default', nullPath);
  }

  // --- identity ---------------------------------------------------------------
  check('case differences compare equal', sameFile('/a/B.pdf', '/a/b.pdf'));
  check('NFC and NFD compare equal', sameFile('/a/café.pdf', '/a/café.pdf'));
  check('different files compare unequal', !sameFile('/a/b.pdf', '/a/c.pdf'));
  check('identityKey is idempotent', identityKey(identityKey('/a/CAFÉ.pdf')) === identityKey('/a/CAFÉ.pdf'));

  // --- the stub must behave like the filesystem it stands in for --------------
  // Every vector above runs against the stub. If the stub and node:fs disagree,
  // the vectors describe a filesystem that does not exist - which is how the
  // first version of this file passed while assuming realpath returned null on
  // absence.
  {
    const { realpathSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bs-gate-')));
    try {
      writeFileSync(join(dir, 'real.txt'), 'x');
      symlinkSync(join(dir, 'real.txt'), join(dir, 'link.txt'));
      symlinkSync(join(dir, 'loopB'), join(dir, 'loopA'));
      symlinkSync(join(dir, 'loopA'), join(dir, 'loopB'));

      const realCode = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };
      check('node:fs realpath throws ENOENT for an absent path',
        realCode(() => realpathSync(join(dir, 'nope.txt'))) === 'ENOENT');
      check('node:fs realpath throws ELOOP for a cycle',
        realCode(() => realpathSync(join(dir, 'loopA'))) === 'ELOOP');
      check('node:fs realpath dereferences a link',
        realpathSync(join(dir, 'link.txt')) === join(dir, 'real.txt'));

      const stub = stubFs({
        links: { [join(dir, 'link.txt')]: join(dir, 'real.txt'), [join(dir, 'loopA')]: join(dir, 'loopB'), [join(dir, 'loopB')]: join(dir, 'loopA') },
        missing: [join(dir, 'nope.txt')],
      });
      const stubCode = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };
      check('the stub agrees with node:fs on absence',
        stubCode(() => stub.realpath(join(dir, 'nope.txt'))) === 'ENOENT');
      check('the stub agrees with node:fs on cycles',
        stubCode(() => stub.realpath(join(dir, 'loopA'))) === 'ELOOP');
      check('the stub agrees with node:fs on dereferencing',
        stub.realpath(join(dir, 'link.txt')) === realpathSync(join(dir, 'link.txt')));

      // A relative target resolves against the directory holding the link. The
      // stub treated it as absolute until a review pointed out that no
      // filesystem does.
      symlinkSync('real.txt', join(dir, 'rel.txt'));
      const relStub = stubFs({ links: { [join(dir, 'rel.txt')]: 'real.txt' } });
      check('the stub agrees with node:fs on a relative link target',
        relStub.realpath(join(dir, 'rel.txt')) === realpathSync(join(dir, 'rel.txt')),
        `${relStub.realpath(join(dir, 'rel.txt'))} vs ${realpathSync(join(dir, 'rel.txt'))}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // --- the window between check and use ---------------------------------------
  // resolve() checks the path it was given; the access must reach the file that
  // was checked, not whatever the path names by then. A component replaced in
  // between is followed by anything that re-resolves the string.
  {
    const ROOT2 = ROOT;
    const mkSwappable = () => {
      let swapped = false;
      const deref = (p) => (swapped && p.startsWith(`${ROOT2}/sub`) ? `/etc${p.slice(`${ROOT2}/sub`.length)}` : p);
      return {
        swap() { swapped = true; },
        withHandles: {
          realpath: deref,
          isDirectory: () => false,
          open: (p) => ({ boundTo: deref(p) }),
          readHandle: (h) => `content-of:${h.boundTo}`,
          writeHandle: () => true,
        },
        pathOnly: {
          realpath: deref,
          isDirectory: () => false,
          read: (p) => `content-of:${deref(p)}`,
          write: () => true,
        },
      };
    };

    const bound = mkSwappable();
    check('a filesystem offering handles is recognised', bindsToHandles(bound.withHandles));
    const gb = createGate({ fs: bound.withHandles, authorisedRoots: [ROOT2] });
    const rb = gb.forRead(`${ROOT2}/sub/a.pdf`);
    bound.swap();
    checkOk('a replaced component does not change what a bound read returns',
      () => readFile(bound.withHandles, rb) === `content-of:${ROOT2}/sub/a.pdf`);

    const unbound = mkSwappable();
    check('a filesystem without handles is recognised as such', !bindsToHandles(unbound.pathOnly));
    const gu = createGate({ fs: unbound.pathOnly, authorisedRoots: [ROOT2] });
    const ru = gu.forRead(`${ROOT2}/sub/a.pdf`);
    unbound.swap();
    checkOk('without handles the window is open, and the suite says so rather than pretending',
      () => readFile(unbound.pathOnly, ru) === 'content-of:/etc/a.pdf');
  }

  // --- case rules are probed per root -----------------------------------------
  // Roots can sit on volumes with different rules. One rule applied to all of
  // them takes an authorisation decision with the wrong comparison for some.
  {
    const mixed = { ...stubFs(), isCaseInsensitive: (root) => root === '/case-insensitive' };
    let refused = false;
    try { createGate({ fs: mixed, authorisedRoots: ['/case-insensitive', '/case-sensitive'] }); } catch { refused = true; }
    check('roots on volumes with different case rules are refused', refused);
    checkOk('roots sharing a case rule are accepted',
      () => createGate({ fs: mixed, authorisedRoots: ['/case-insensitive'] })
        .forRead('/CASE-INSENSITIVE/a.pdf').path === '/CASE-INSENSITIVE/a.pdf');
  }

  // --- case folding follows the volume, not a constant ------------------------
  // On a case-sensitive filesystem /ROOT/secret is not inside /root, and folding
  // case would authorise it. §13.4's root check is an authorisation decision, so
  // it has to match how the volume actually compares names.
  {
    const sensitive = { ...stubFs(), isCaseInsensitive: () => false };
    const g = createGate({ fs: sensitive, authorisedRoots: ['/root'] });
    let refused = false;
    try { g.forRead('/ROOT/secret'); } catch (e) { refused = e.reason === 'outside_authorised_roots'; }
    check('a case-sensitive volume does not fold case for the root check', refused);
    checkOk('the same volume still allows the exact root', () => g.forRead('/root/a.pdf').path === '/root/a.pdf');

    const insensitive = { ...stubFs(), isCaseInsensitive: () => true };
    checkOk('a case-insensitive volume treats a differently-cased root as the same root',
      () => createGate({ fs: insensitive, authorisedRoots: ['/root'] }).forRead('/ROOT/secret').path === '/ROOT/secret');
  }

  // --- every declared rejection reason is reachable ---------------------------
  // A reason listed in path-rules.json with no vector that triggers it is a rule
  // nobody has shown the gate can enforce.
  const unreached = REJECTION_REASONS.filter((r) => !triggered.has(r));
  check('every declared rejection reason is triggered by a vector', unreached.length === 0,
    `never triggered: ${unreached.join(', ')}`);

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  path gate: ${REJECTION_REASONS.length} reasons, ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}
