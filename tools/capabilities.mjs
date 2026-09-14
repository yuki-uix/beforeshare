/**
 * Builds the capability declaration from the detector registry.
 *
 * It is generated rather than written by hand for one reason: §14.1 requires each
 * format adapter to declare exact capabilities, and a hand-maintained list drifts
 * from the detectors actually registered. The drift then looks exactly like a
 * correct declaration — which is worse than no declaration, because
 * `coverage.skipped` is supposed to be traceable back to it (§17.1).
 *
 * Adding a detector to the registry therefore changes the published capability
 * automatically, and tools/validate-schemas.mjs fails if the committed example
 * and the generated output disagree.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_MEDIA_TYPES } from './media-types.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, '..', 'schemas', 'v1');
const read = (f) => JSON.parse(readFileSync(join(schemaDir, f), 'utf8'));

export const REGISTRY = read('detector-registry.json');

/**
 * Per-action facts that do not vary by file.
 *
 * `verifiable` says whether THIS BUILD has an independent reader for the action —
 * not whether one is possible in principle. The two are different claims, and a
 * single boolean carrying both lets a design intention be published as a fact.
 *
 * No verifier is implemented yet, so every action is `no_verifier_implemented`
 * and carries only `plannedSurfaces`. The schema forbids that state from
 * claiming a reader. This mirrors `testedLimits`: an unmeasured limit and an
 * unwritten verifier are both things a build must say it lacks rather than
 * describe optimistically.
 *
 * When a verifier lands, the action moves to `independent_reader_available` with
 * the surfaces it actually reads. An action that can never reach that state must
 * not be offered at all: §10.2 has no "probably fine" outcome, so it would end
 * as `unable_to_verify` every time.
 */
export const ACTION_FACTS = {
  remove_pdf_metadata_field: {
    status: 'not_implemented',
    waitingOn: '#7',
    possibleSideEffects: ['invalidates_digital_signature'],
    confirmationRequired: false,
    verifiable: { status: 'no_verifier_implemented', plannedSurfaces: ['metadata_block', 'raw_objects'] },
    mediaTypes: ['application/pdf'],
  },
  remove_image_metadata_field: {
    status: 'not_implemented',
    waitingOn: '#7',
    possibleSideEffects: ['alters_visual_rendering'],
    confirmationRequired: false,
    verifiable: { status: 'no_verifier_implemented', plannedSurfaces: ['metadata_block'] },
    mediaTypes: ['image/jpeg', 'image/png'],
  },
  remove_annotations: {
    status: 'not_implemented',
    waitingOn: '#7',
    possibleSideEffects: ['invalidates_digital_signature', 'removes_interactive_behavior', 'makes_future_editing_harder'],
    confirmationRequired: true,
    verifiable: { status: 'no_verifier_implemented', plannedSurfaces: ['annotations', 'raw_objects', 'extracted_text'] },
    mediaTypes: ['application/pdf'],
  },
  remove_embedded_files: {
    status: 'not_implemented',
    waitingOn: '#7',
    possibleSideEffects: ['invalidates_digital_signature', 'makes_future_editing_harder'],
    confirmationRequired: true,
    verifiable: { status: 'no_verifier_implemented', plannedSurfaces: ['attachments', 'raw_objects'] },
    mediaTypes: ['application/pdf'],
  },
  disable_javascript_and_launch_actions: {
    status: 'not_implemented',
    waitingOn: '#7',
    possibleSideEffects: ['invalidates_digital_signature', 'removes_interactive_behavior'],
    confirmationRequired: false,
    verifiable: { status: 'no_verifier_implemented', plannedSurfaces: ['raw_objects'] },
    mediaTypes: ['application/pdf'],
  },
  clear_form_values: {
    status: 'not_implemented',
    waitingOn: '#7',
    possibleSideEffects: ['invalidates_digital_signature', 'removes_interactive_behavior', 'makes_future_editing_harder'],
    confirmationRequired: true,
    verifiable: { status: 'no_verifier_implemented', plannedSurfaces: ['raw_objects', 'extracted_text'] },
    mediaTypes: ['application/pdf'],
  },
  flatten_to_high_assurance_copy: {
    status: 'not_implemented',
    waitingOn: '#7',
    possibleSideEffects: [
      'invalidates_digital_signature',
      'removes_accessible_or_searchable_text',
      'flattens_forms_or_annotations',
      'alters_visual_rendering',
      'removes_interactive_behavior',
      'makes_future_editing_harder',
    ],
    confirmationRequired: true,
    verifiable: { status: 'no_verifier_implemented', plannedSurfaces: ['extracted_text', 'rendered_page', 'raw_objects'] },
    mediaTypes: ['application/pdf'],
  },
  apply_visual_redaction: {
    status: 'not_implemented',
    waitingOn: '#7',
    possibleSideEffects: ['removes_accessible_or_searchable_text', 'alters_visual_rendering', 'makes_future_editing_harder'],
    confirmationRequired: true,
    verifiable: { status: 'no_verifier_implemented', plannedSurfaces: ['extracted_text', 'rendered_page', 'raw_objects', 'image_pixels'] },
    mediaTypes: ['application/pdf', 'image/jpeg', 'image/png'],
  },
};

/**
 * No file has been measured yet: no parser exists. Publishing a plausible number
 * here would be an untested limit presented as a measurement.
 */
export const UNMEASURED = {
  status: 'not_established',
  reason: 'No format adapter is implemented yet, so no file size or page count has been tested on any reference machine.',
};

export { SUPPORTED_MEDIA_TYPES } from './media-types.mjs';

/**
 * A detector or action declaring a media type outside the closed set would be
 * dropped from `formats` silently while still appearing in `versions.detectors` —
 * present in the declaration, absent from every format that could use it. Fail
 * instead.
 */
export function unsupportedMediaTypesInSources() {
  const bad = [];
  for (const [id, d] of Object.entries(REGISTRY.detectors)) {
    for (const mt of d.mediaTypes) if (!SUPPORTED_MEDIA_TYPES.includes(mt)) bad.push(`detector ${id}: ${mt}`);
  }
  for (const [action, f] of Object.entries(ACTION_FACTS)) {
    for (const mt of f.mediaTypes) if (!SUPPORTED_MEDIA_TYPES.includes(mt)) bad.push(`action ${action}: ${mt}`);
  }
  return bad;
}

export function buildCapabilities({ core = '0.1.0', app, testedLimits = {} } = {}) {
  const bad = unsupportedMediaTypesInSources();
  if (bad.length > 0) {
    throw new Error(`media types outside the supported set: ${bad.join('; ')}`);
  }
  const mediaTypes = SUPPORTED_MEDIA_TYPES;

  const formats = mediaTypes.map((mediaType) => ({
    mediaType,
    detectors: Object.entries(REGISTRY.detectors)
      .filter(([, d]) => d.mediaTypes.includes(mediaType))
      .map(([id, d]) => ({
        id,
        version: d.version,
        certainty: d.certainty,
        emits: d.emits,
        status: d.status,
        ...(d.status === 'implemented' ? { adapter: d.adapter } : { waitingOn: d.waitingOn }),
      })),
    actions: Object.entries(ACTION_FACTS)
      .filter(([, f]) => f.mediaTypes.includes(mediaType))
      .map(([action]) => action),
    testedLimits: testedLimits[mediaType] ?? UNMEASURED,
  }));

  const detectors = Object.entries(REGISTRY.detectors).map(([id, d]) => ({ id, version: d.version }));

  // Derived, never hand-set. A consumer of get_capabilities makes a yes/no
  // decision; requiring it to scan two dozen per-entry statuses to learn that
  // nothing works is the same "partial reads as complete" failure the per-entry
  // statuses were added to prevent.
  const anyDetector = formats.some((f) => f.detectors.some((d) => d.status === 'implemented'));
  const anyAction = Object.values(ACTION_FACTS).some((f) => f.status === 'implemented');

  const out = {
    schemaVersion: '1.0',
    operational: {
      canInspect: anyDetector,
      canRemediate: anyAction,
      summary: anyDetector || anyAction
        ? 'Some capabilities are implemented; see each entry.'
        : 'This build implements no detector and no remediation action. It can describe what it will do, not do it.',
    },
    versions: { core, ...(app ? { app } : {}), detectors },
    formats,
    actions: Object.entries(ACTION_FACTS).map(([action, f]) => ({
      action,
      status: f.status,
      ...(f.status === 'implemented' ? {} : { waitingOn: f.waitingOn }),
      possibleSideEffects: f.possibleSideEffects,
      confirmationRequired: f.confirmationRequired,
      verifiable: f.verifiable,
    })),
    limitations: [
      {
        code: 'signature_present_remediation_restricted',
        message: 'Any change to a signed PDF invalidates its signature. BeforeShare reports the signature but does not re-sign.',
        mediaTypes: ['application/pdf'],
      },
      {
        code: 'language_not_covered_by_ocr',
        message: 'Visible-text recognition is evaluated for English and Simplified Chinese. Other scripts are not claimed.',
        mediaTypes: ['application/pdf', 'image/jpeg', 'image/png'],
      },
    ],
  };
  return out;
}
