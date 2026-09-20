# Capability declaration

Schema: [`schemas/v1/capabilities.schema.json`](../../schemas/v1/capabilities.schema.json).
Source: [`schemas/v1/detector-registry.json`](../../schemas/v1/detector-registry.json).
Generator: [`tools/capabilities.mjs`](../../tools/capabilities.mjs).

## It is generated, not written

§14.1: *"Each format adapter must declare exact capabilities rather than relying on a generic
'supported' flag."*

A hand-maintained capability list satisfies that sentence on the day it is written and drifts
afterwards — and the drift looks exactly like a correct declaration. So the declaration is built from
the detector registry, and `npm run validate` fails if the committed copy and the generated one
differ. Adding a detector changes the published capability automatically; forgetting to regenerate is
a build failure, not a silent inaccuracy.

This matters beyond tidiness: §17.1 requires coverage reporting to be 100% accurate, and
`coverage.skipped` is only meaningful if "this detector did not run" traces back to a capability that
said it could.

## There is no boolean that means "supported"

The schema provides no place to put one. A format entry requires a non-empty `detectors` array, so a
format with nothing behind it is not expressible. `actions` may be empty — inspection without
remediation is a real state and worth being able to say.

## Untested limits say so

§13.1 requires the maximum tested size to be published. The seven PDF detectors are implemented,
but limits have not been measured on a reference machine. The four budgets in
`limit-rules.json` remain provisional; [#56](https://github.com/yuki-uix/beforeshare/issues/56)
owns those measurements. The declaration uses `UNMEASURED` from the generator:

```json
"testedLimits": {
  "status": "not_established",
  "reason": "No limit has been measured on a reference machine: limit-rules.json marks all four budgets provisional and names #56 as owing the numbers. A plausible figure here would be an untested limit published as a measurement."
}
```

`not_established` is a first-class state and **the schema forbids it from carrying numbers**. The
alternatives were to leave the field out or to put in a plausible figure; both publish an untested
limit as though it were a measurement, which is the kind of unearned claim §5.3 rules out. When
limits are measured, `status: "measured"` requires the size, the reference machine and the date — and
forbids the `reason` field, so a measured entry cannot also carry an excuse.

## Actions declare what they might cost, and whether they can be checked

Each format entry lists the actions that **apply** to it with their status, rather than bare action
names. Naming the action alone read as availability: an earlier version listed seven actions under
`application/pdf` while none was implemented, and a consumer had to cross-reference the top-level
`actions` array to find that out.

`possibleSideEffects` is the static superset for an action across all files. The per-file subset lives
on each finding's `remediation.sideEffects` — a PDF with no signature does not get a signature
warning, and a warning that is usually wrong is one users learn to click past.

`confirmationRequired` is where CLI exit code `8` and the MCP approval gate read from, for the actions
§9.1 marks as needing explicit confirmation.

`verifiable` says whether **this build** has an independent reader for the action — not whether one
is possible in principle. Those are different claims, and an earlier draft of this file used a single
boolean for both: every action was marked independently verifiable while not one verifier existed, so
the validator's assertion that "every action is verifiable" was vacuously true.

No verifier is implemented yet, so every action currently reads:

```json
"verifiable": { "status": "no_verifier_implemented", "plannedSurfaces": ["metadata_block", "raw_objects"] }
```

That is `remove_pdf_metadata_field`. `plannedSurfaces` differs per action and is not a shared
default — `remove_image_metadata_field` plans only `metadata_block`, `remove_annotations` adds
`annotations` and `extracted_text`, and `apply_visual_redaction` adds `rendered_page` and
`image_pixels`. The authoritative list is `ACTION_FACTS` in
[`tools/capabilities.mjs`](../../tools/capabilities.mjs); this snippet is one entry, not the shape
they all share.

The schema forbids that state from naming `surfaces` it covers, and forbids the implemented state
from falling back to `plannedSurfaces`. Same shape as `testedLimits`, for the same reason: an
unmeasured limit and an unwritten verifier are both things a build has to say it lacks rather than
describe optimistically.

**The claim has to point at something.** Making the status explicit was not enough on its own — the
first version of this guard would still have passed if all eight actions were flipped to
`independent_reader_available`, because nothing checked whether the readers existed. So
`detector-registry.json` carries a `verifiers` section, deliberately empty, and a claimed reader must
be registered there. Changing the status now requires a verifier to exist, not a string to be
edited.

An action that can never reach `independent_reader_available` must not be offered at all — §10.2 has
no "probably fine" outcome, so it would end as `unable_to_verify` every time. `apply_visual_redaction`
is the one to watch: §9.1 requires the underlying content to be unrecoverable by supported independent
extractors, which is the hardest claim in the whole document to make good on.

## What the registry also buys

Detector ids appear by hand in `coverage.completed`, in each finding's `detector`, in `versions`, and
in `limitations.affectedDetectors`. An unregistered id in any of those is a typo that silently claims
a check ran. The validator rejects every detector id in a committed example that is not in the
registry, and requires every declared category to be emitted by at least one detector — a category
nothing can produce is a taxonomy entry with no path to the user.

## Seven detectors are implemented; nothing else is

The seven PDF detectors declare `status: "implemented"` and name the adapter that implements them.
Every other detector and every action still declares `not_implemented` with the issue it waits on.

This file said "nothing here is implemented" for two PRs after the PDF detectors shipped, and so did
the registry: the declaration published `canInspect: false` while the core was inspecting. Prose is
not run, and neither was the registry - so the results suite now ties the two together in both
directions, and a detector that completes a run without being declared fails the build.

This was not the first version. The registry originally listed twelve detectors with no status, and
`buildCapabilities` published them — so a consumer reading the declaration would have concluded this
build inspects PDFs, JPEGs and PNGs. The same mistake had already been caught once in this file, for
`verifiable`, and was left standing one field away.

`implemented` requires an `adapter` module, so the status cannot be advanced by editing a string.

## One field answers "can this build do anything"

`operational` carries `canInspect`, `canRemediate` and a sentence. Both booleans are **derived** from
the per-entry statuses, never set by hand.

It exists because a consumer of `get_capabilities` is an agent making a yes/no decision, and the
per-entry statuses alone would make it scan two dozen entries to learn that nothing works — which is
the same "partial reads as complete" failure the statuses were added to prevent. Today it reads:

```json
"operational": {
  "canInspect": true,
  "canRemediate": false,
  "summary": "Some capabilities are implemented; see each entry."
}
```

Derived is what makes that sentence safe to move: the booleans changed when the registry did, and
nobody edited them.

## Not decided here

| Question | Owner |
|---|---|
| Which detectors actually exist, and their adapters | E4 (#5), E5 (#6) — the PDF seven are in; the image and OCR detectors are declared here and built there, so the registry can only say what has been claimed |
| Which remediation actions exist | E6 (#7) — the enum is closed here and the eight actions are implemented there |
| Which independent verifiers exist | E7 (#8) — a verifier that shares a reader with the detector is not independent, and only the pipeline can tell |
| Maximum tested sizes, on a named reference machine | #55 — the reference machine settles every §17.4 number at once, and an adapter has to exist first |
