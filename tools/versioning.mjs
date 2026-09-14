/**
 * Schema version semantics and result staleness.
 *
 * §20.3 requires schema versions to be explicit and compatibility to be tested.
 * §14.1 requires parser and detector versions to be visible in results and a
 * changed input to invalidate an earlier approval. This is where both become
 * checkable rather than described.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, '..', 'schemas', 'v1');
const read = (f) => JSON.parse(readFileSync(join(schemaDir, f), 'utf8'));

export const CHANGELOG = read('CHANGELOG.json');
export const REGISTRY = read('detector-registry.json');

export const CHANGE_TYPES = ['breaking', 'additive', 'editorial'];

/**
 * What counts as breaking.
 *
 * The unobvious member of this list is `enum_value_added`. §20.3 requires
 * consumers to fail visibly on unknown enum values, so a consumer pinned to an
 * older version WILL reject a value added later. That rejection is the intended
 * behaviour — a consumer silently tolerating a category it has never heard of
 * would be deciding on its own that an unknown disclosure class is safe to
 * ignore — but it means adding a value is a compatibility event, not a free
 * extension. It is classified `additive` and gated by MINOR precisely because
 * the consumer contract below makes an older consumer refuse the newer result.
 */
export const BREAKING_KINDS = [
  'field_removed',
  'field_renamed',
  'optional_field_made_required',
  'enum_value_removed',
  'constraint_tightened',
  'type_changed',
];

export const ADDITIVE_KINDS = [
  'optional_field_added',
  'enum_value_added',
  'description_clarified_without_behaviour_change',
];

export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)$/.exec(v ?? '');
  if (!m) throw new Error(`not a schema version: ${v}`);
  return { major: Number(m[1]), minor: Number(m[2]) };
}

/**
 * Whether a consumer that understands `consumerVersion` may read a result
 * declaring `resultVersion`.
 *
 * Forward compatibility is deliberately absent: a newer result may contain enum
 * values or required fields the older consumer does not know, and §20.3 says it
 * must fail visibly rather than guess.
 */
export function canConsume(resultVersion, consumerVersion) {
  const r = parseVersion(resultVersion);
  const c = parseVersion(consumerVersion);
  if (r.major !== c.major) return { ok: false, reason: `major ${r.major} cannot be read by a consumer built for major ${c.major}` };
  if (r.minor > c.minor) return { ok: false, reason: `result is ${resultVersion}; this consumer understands up to ${consumerVersion}` };
  return { ok: true, reason: 'within the consumer\'s declared range' };
}

/**
 * Whether a stored result may still be reused.
 *
 * A result is stale when any component that produced it has moved on. §14.1
 * requires a changed input to invalidate an earlier approval; the same applies
 * to a changed detector, because the finding set it would produce today is not
 * the one recorded here. Reusing it silently is how a fixed false negative
 * quietly stays fixed only in the new code.
 *
 * @param {object} result           a canonical inspection result
 * @param {object} current          { core, detectors: {id: version} }
 * @returns {{stale: boolean, reasons: string[]}}
 */
export function resultIsStale(result, current) {
  const reasons = [];

  if (current.core && result.versions?.core && current.core !== result.versions.core) {
    reasons.push(`core ${result.versions.core} -> ${current.core}`);
  }

  for (const d of result.versions?.detectors ?? []) {
    const now = current.detectors?.[d.id];
    if (now === undefined) reasons.push(`detector ${d.id} no longer exists`);
    else if (now !== d.version) reasons.push(`detector ${d.id} ${d.version} -> ${now}`);
  }

  // A detector that applies to this media type but is absent from the result also
  // invalidates it: this build would look at something the stored result never
  // did. Scoped by media type, because an image detector missing from a PDF
  // result is not staleness, it is the detector not applying.
  const mediaType = result.input?.mediaType;
  const recorded = new Set((result.versions?.detectors ?? []).map((d) => d.id));
  for (const [id, d] of Object.entries(REGISTRY.detectors)) {
    if (mediaType && !d.mediaTypes.includes(mediaType)) continue;
    if (!recorded.has(id)) reasons.push(`detector ${id} applies to this file but was not part of the result`);
  }

  return { stale: reasons.length > 0, reasons };
}

/** The detector versions this build would use right now. */
export function currentDetectorVersions() {
  return Object.fromEntries(Object.entries(REGISTRY.detectors).map(([id, d]) => [id, d.version]));
}

/**
 * Checks the changelog against itself: a breaking change must coincide with a
 * MAJOR bump. Recording one under an unchanged MAJOR is how a contract breaks
 * consumers while claiming it did not.
 */
export function changelogViolations(changelog = CHANGELOG) {
  const violations = [];
  const releases = [...changelog.releases].reverse();
  let previous = null;
  for (const rel of releases) {
    const v = parseVersion(rel.version);
    for (const c of rel.changes) {
      if (!CHANGE_TYPES.includes(c.type)) violations.push(`${rel.version}: unknown change type ${c.type}`);
      if (c.type === 'breaking' && previous && v.major === previous.major) {
        violations.push(`${rel.version}: a breaking change was released without a major bump`);
      }
    }
    previous = v;
  }
  return violations;
}
