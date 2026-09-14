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

§13.1 requires the maximum tested size to be published. No format adapter exists yet, so nothing has
been measured on any machine. The declaration therefore says:

```json
"testedLimits": {
  "status": "not_established",
  "reason": "No format adapter is implemented yet, so no file size or page count has been tested on any reference machine."
}
```

`not_established` is a first-class state and **the schema forbids it from carrying numbers**. The
alternatives were to leave the field out or to put in a plausible figure; both publish an untested
limit as though it were a measurement, which is the kind of unearned claim §5.3 rules out. When
limits are measured, `status: "measured"` requires the size, the reference machine and the date — and
forbids the `reason` field, so a measured entry cannot also carry an excuse.

## Actions declare what they might cost, and whether they can be checked

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
