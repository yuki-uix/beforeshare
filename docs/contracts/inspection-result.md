# Inspection result contract v1.0

Schemas: [`schemas/v1/`](../../schemas/v1). Run `npm run validate` to check them.

This document records the decisions behind the schema — particularly the places where
[the product case study](../product-case-study.md) states a requirement without stating how to
satisfy it. Where the case study was silent, the choice made here is written down as a choice, not
presented as if the document had specified it.

## What this contract is for

§14.1 requires that the desktop application, the CLI and the MCP server not implement divergent
detection logic. A shared schema is the weakest form of that guarantee — it constrains the shape of
what they return, not how they arrive at it — but it is the part that can be enforced mechanically,
starting now, before any of the three interfaces exist.

## Decisions

### `runId` is a ULID, and carries no meaning

Locally generated, unique per run on this device. Deliberately not derived from the file path or
hash: a run identifier that encodes its input becomes a way to leak the input, and it would collide
for two inspections of the same file that must be distinguishable (§20.2 lists concurrent requests
for the same input as a required test case).

### `input.mediaType` is sniffed, never taken from the extension

§20.1 requires a test for "wrong extension and MIME mismatch" but does not say which side wins.
Decision: **content wins**. `mediaType` always describes what was actually parsed. When the
extension disagrees, `declaredMediaType` records what the filename claimed and a
`media_type_mismatch` limitation is raised. The mismatch is never resolved silently, because a file
named `.jpg` that is really a PDF is itself a signal worth showing the user.

### `input.path` is present in the result, absent from logs

§21.2 forbids absolute or partial paths in default logs and exported diagnostics. It does not forbid
them in the result handed back to the caller who supplied the path in the first place. The boundary
is: **the result may carry it; anything that persists, exports, or forwards the result must strip
it.** This is a real obligation on E13 (logging) and E10 (MCP), not a detail the schema can enforce
on its own, so it is stated in the field description too.

### `coverage.skipped` and `.failed` carry reasons — a deviation from the §8 example

The example in §8 shows three bare string arrays. §17.1 requires accurate coverage reporting at
100% and zero checks mislabelled as completed. A bare identifier in `skipped` satisfies neither the
user ("why wasn't this checked?") nor the metric (nothing distinguishes "not applicable" from
"crashed"). So `skipped` entries require a `coverageSkipReason` and `failed` entries require a
`detectorFailureCode`.

This is an extension of the case study's stated *minimum*, and it is the largest shape difference
from the printed example. It is called out here so it is reviewed as a decision rather than
discovered later as drift.

### `findings` order is part of the contract

§17.5 requires deterministic output for repeated inspection of the same file at the same detector
versions. Array order is observable output, so it is specified: severity descending, then category,
then canonical location, then id. Without this, a result set could be byte-different run to run while
every individual value stayed identical.

### `severity` has four levels; "blocking" is not one of them

`low` / `medium` / `high` / `critical`. §8.1 has a `blocking_findings` status, which implies some
findings block — but whether blocking is a severity level, a separate flag, or a derived property is
not stated.

Decision: **blocking is derived, not stored.** Storing it would let two code paths disagree about
whether the same finding blocks. The derivation rule itself belongs to the status decision table and
is owned by issue #18. The starting position handed to that issue: a finding blocks only when it is
`critical` **and** `deterministic` — a probabilistic finding must never block on its own, because
§7.3 forbids presenting ambiguous categories as facts without user review.

### `certainty` is per finding, not per category

The same category arrives by different paths: GPS coordinates read from an EXIF tag are
deterministic; the same coordinates recognised in visible text by OCR are not. Attaching certainty to
the category would force one of those two to be mislabelled. Every finding therefore also carries
`detector` (id + version), which is what makes the certainty claim auditable.

### `evidence` has no field that can hold the real value

§8.2 says full sensitive values must not appear in ordinary UI summaries, logs, telemetry or agent
tool descriptions, and that the user may explicitly reveal a value in the local UI.

Decision: **the schema provides no representation for the unmasked value at all.** Reveal is an
out-of-band local call keyed by `(runId, findingId)`, available only to the desktop UI. The
alternative — an optional `fullValue` field populated only sometimes — makes every consumer
responsible for never serialising it, and one mistake in one code path is a disclosure. Removing the
field removes the class of mistake. Masking rules are in [masking.md](masking.md).

### `remediation.sideEffects` is computed per file, not declared per action

Removing metadata from an unsigned PDF cannot invalidate a signature. A static per-action warning
list would show that warning anyway, and a warning that is usually wrong is a warning users learn to
click past. The static superset per action belongs in the capability declaration (issue #23); this
field states what applies to *this* file.

An empty `sideEffects` array is therefore a positive claim that none of the six classes in §9.2
apply — not an unfilled default.

### `actionGroupId` answers the deduplication question

Five findings on author / creator / producer / title / keywords are five things the user reviews and
approves individually, but one metadata write. They share an `actionGroupId`; the remediation engine
coalesces by that id. This keeps review granularity independent of execution granularity, which is
what §9.3's ban on hidden bulk actions requires — the user sees five decisions, not one.

### Every enumeration is closed

§20.3 requires unknown enum values to fail visibly. `additionalProperties: false` and closed enums
throughout; the validator pins this with negative cases. The consequence is that **adding an enum
value is a compatibility event**, not a free extension — a consumer pinned to 1.0 will reject a value
added in 1.1, which is the intended behaviour rather than a bug. The policy for that is owned by
issue #25.

## What this PR deliberately does not decide

| Question | Owner |
|---|---|
| How `status` is computed from coverage + findings | #18 |
| Which exit code each status maps to | #24 |
| The verification result schema | #22 |
| The capability declaration, and the static per-action side-effect superset | #23 |
| Version granularity and the compatibility policy | #25 |
| Cross-interface equivalence tests | #26 |

`status` and `versions` appear in this schema because examples cannot be written without them. Their
*shape* is fixed here; their *semantics* are not.

## Tooling note

`package.json` and `tools/validate-schemas.mjs` exist to validate the schemas in CI. This is build
tooling only — the schemas are language-agnostic JSON Schema and this choice does not commit the
product to a runtime. The core language decision is still open and belongs in its own ADR.
