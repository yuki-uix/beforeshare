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

The validator checks the committed examples against this ordering. It is not enough to write the rule
down: the first draft of this PR documented the ordering and then shipped an example that violated
it, which is the worst of both — a rule stated confidently and a reference file teaching the opposite.

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

### The two remediation variants are mutually exclusive

`supported: true` requires an action and its side effects, and forbids `unsupportedReason` and
`unsupportedDetail`. `supported: false` requires a reason, and forbids `action`, `sideEffects`,
`alternativeActions` and `actionGroupId`. A payload carrying both halves tells a consumer that
remediation can and cannot run at the same time; the schema now rejects it rather than leaving each
of the three interfaces to decide which half to believe.

### `remediation.sideEffects` is computed per file, not declared per action

Removing metadata from an unsigned PDF cannot invalidate a signature. A static per-action warning
list would show that warning anyway, and a warning that is usually wrong is a warning users learn to
click past. The static superset per action belongs in the capability declaration (issue #23); this
field states what applies to *this* file.

An empty `sideEffects` array is therefore a positive claim that none of the six classes in §9.2
apply — not an unfilled default.

### There are eight remediation actions, not seven

§9.1 lists eight bullets. Two of them — "remove selected PDF metadata fields" and "remove selected
image metadata fields" — describe the same verb over different formats, and an earlier draft of this
work merged them into a single `remove_metadata_field`. That merge was wrong, and it is worth
recording why rather than quietly fixing it:

- the two actions run through different parsers and have different failure modes;
- their side effects differ — an image rewrite can change orientation, a PDF rewrite can invalidate a
  signature;
- §14.1 requires each format adapter to declare exact capabilities, which a shared action value
  cannot express when one format supports it and the other does not.

So the enum carries `remove_pdf_metadata_field` and `remove_image_metadata_field` separately.

**This makes the schema differ from the illustrative result in §8**, which prints
`"action": "remove_metadata_field"`. §8 is a minimum example, §9.1 is the requirement; where they
disagree the requirement wins. The difference is recorded here so it reads as a decision rather than
as drift.

### Per-category defaults live in a table the build checks

[`schemas/v1/category-defaults.json`](../../schemas/v1/category-defaults.json) gives every category a
`defaultCertainty`, a `defaultSeverity`, and a `certaintyMayVary` flag. It is not a JSON Schema — it
is the table detectors read, and the table the status rules (#18) will read.

The point of the file is the check around it: `npm run validate` fails when the table and the
`category` enum disagree in either direction. **Adding a category therefore forces a decision about
its certainty and severity**, instead of letting a new detector pick whichever values it likes at the
call site. The validator also rejects any example whose finding deviates from its default certainty
unless the table marks that category as one where certainty legitimately varies.

Three categories are probabilistic by default — `pii_postal_address`, `pii_person_name`, and
`pii_government_or_account_id` — because §7.3 names addresses and full names as ambiguous. Seven more
are marked `certaintyMayVary`, all for the same structural reason: the same fact read out of a
metadata field is deterministic, and read out of an image by OCR is not.

### Adding to a closed enum: the process

1. Add the value to the enum in `enums.schema.json`.
2. For a `category`, add its row to `category-defaults.json` — the build fails until you do.
3. For a `remediationAction`, confirm a verification path exists (§10.1). An action nothing can
   verify must not be offered, because §10.2 would leave it permanently `unable_to_verify`.
4. Bump the schema MINOR version.
5. Note it in the changelog.

Consumers pinned to an earlier MINOR will reject the new value. That is intended: §20.3 requires
unknown enum values to fail visibly, and a consumer that silently tolerated one would be deciding, on
its own, that a category it has never heard of is safe to ignore.

### `actionGroupId` answers the deduplication question

Five findings on author / creator / producer / title / keywords are five things the user reviews and
approves individually, but one metadata write. They share an `actionGroupId`; the remediation engine
coalesces by that id. This keeps review granularity independent of execution granularity, which is
what §9.3's ban on hidden bulk actions requires — the user sees five decisions, not one.

### Every enumeration is closed

§20.3 requires unknown enum values to fail visibly. `additionalProperties: false` and closed enums
throughout; the validator pins this with negative cases. The consequence is that **adding an enum
value is a compatibility event**, not a free extension — see the process above. How MINOR bumps are
negotiated with pinned consumers over the long run is owned by issue #25.

## What this PR deliberately does not decide

| Question | Owner |
|---|---|
| How `status` is computed from coverage + findings | #18 |
| Which exit code each status maps to | #24 |
| The verification result schema | #22 |
| The capability declaration, and the static per-action side-effect superset | #23 |
| Version granularity and the long-run compatibility policy | #25 |
| Which detectors actually emit which category | E3 / E4 / E5 |
| Cross-interface equivalence tests | #26 |

`status` and `versions` appear in this schema because examples cannot be written without them. Their
*shape* is fixed here; their *semantics* are not.

## The guards are checked for being able to fail

`.github/workflows/contracts.yml` runs the suite, and then runs a second job that
deliberately breaks three invariants on a throwaway copy — an undeclared category, a reversed
example, a removed schema constraint — and asserts the suite goes red each time.

Each case asserts the suite fails **for the expected reason**, matching the specific message the guard
emits. Asserting only that it fails would accept any failure at all — a malformed mutation, a missing
dependency, a bad path — as proof the guard works, which is the same mistake the guards exist to
prevent. A control case with nothing broken keeps a suite that fails unconditionally from satisfying
all three.

A guard that cannot fail is worse than no guard: it reports coverage that does not exist. This branch
already produced two such cases — a bug in the ordering checker that let a non-deterministic ordering
pass, and a first draft of this very job that read a JSON syntax error as evidence the drift check was
working.

## Tooling note

`package.json` and `tools/validate-schemas.mjs` exist to validate the schemas in CI. This is build
tooling only — the schemas are language-agnostic JSON Schema and this choice does not commit the
product to a runtime. The core language decision is still open and belongs in its own ADR.
