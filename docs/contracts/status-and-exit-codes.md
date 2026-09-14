# Status and exit-code contract

Implementation: [`tools/status.mjs`](../../tools/status.mjs),
[`tools/exit-codes.mjs`](../../tools/exit-codes.mjs). Inputs:
[`schemas/v1/status-inputs.json`](../../schemas/v1/status-inputs.json). Run `npm run test:status`.

§8.1 lists six status values and §12.2 lists eight exit codes. Neither section says how to choose
between them, and the two were specified independently with no mapping. This document is that
mapping, and the places where a choice had to be invented are marked as choices.

## The central decision

**The exit code describes the run. The status describes the result.**

| | Question it answers |
|---|---|
| `status` | What did we find in this file? |
| exit code | Was this run complete and usable? |

These are different questions and neither is derivable from the other. Everything below follows from
that split.

### Finding severity never changes the exit code

§12.2 says severity must be communicated in the JSON result "rather than encoded only in process exit
codes", and provides no exit code for "found something bad". So `no_findings`, `review_required` and
`blocking_findings` all exit **0**: in each case the command completed and a valid result is on
stdout.

The consequence is deliberate, and anyone scripting against this needs it stated plainly:

```bash
beforeshare inspect resume.pdf && upload resume.pdf   # uploads a file with critical findings
```

A script must read the JSON. An exit code is not a safety verdict, and a contract that let it look
like one would be the "misleading safe language" §15 lists as a threat.

## Status decision table

Evaluated top to bottom; the first matching row wins.

| # | Condition | Status |
|---|---|---|
| 1 | the run died before producing anything coherent | `failed` |
| 2 | the media type is outside {PDF, JPEG, PNG} | `unsupported` |
| 3 | zero detectors completed | `failed` |
| 4 | any finding is **critical AND deterministic** | `blocking_findings` |
| 5 | any detector failed, was skipped for a coverage-reducing reason, **or the run was cancelled** | `partial` |
| 6 | one or more findings | `review_required` |
| 7 | otherwise | `no_findings` |

Row 2 sits above row 3 deliberately. An out-of-scope file naturally has no completed detectors, so a
table that tested "zero detectors completed" first would report `failed` for it — blaming the run for
something that is a property of the input. Nothing went wrong when BeforeShare is handed a HEIC.

The branch order in [`tools/status.mjs`](../../tools/status.mjs) is this table, row for row.
Reordering one without the other produces a document that describes a different product.

### The five open questions, answered

**1. How do multiple findings aggregate?**
Not by maximum severity. Severity ranks findings; status describes what the user must do. One
blocking finding makes the result `blocking_findings` no matter how many low-severity findings
surround it, and ten `high` findings with none blocking are still `review_required`.

**2. Incomplete coverage AND a high-severity finding — which wins?**
Depends on whether the finding blocks.

- **Blocking finding + incomplete coverage → `blocking_findings`.** Incompleteness does not make a
  critical, deterministic finding less true. The incompleteness is not lost: `coverage` and
  `limitations` are required fields, and **the exit code still reports it** (see below). This is the
  one place status and exit code deliberately disagree.
- **Non-blocking findings + incomplete coverage → `partial`.** `partial` is the only value that says
  "this list is not exhaustive", and that caveat has to survive. A user who fixes the three findings
  listed under a `review_required` headline would reasonably believe they were done.

**3. `unsupported` vs `failed`, and where does an encrypted PDF go?**

- `unsupported` — the input is a kind of thing BeforeShare does not handle. Nothing went wrong.
- `failed` — the input is in scope but this run produced nothing usable.
- An encrypted PDF **is** a supported media type. If metadata could still be read, detectors
  completed and findings exist, so it is `partial`, not `failed`. If nothing could be read at all,
  zero detectors completed and row 1 makes it `failed`.

The rule that separates them: **`partial` requires at least one completed detector.** A result where
nothing completed describes nothing about the file and must not be phrased in terms of what was or
was not found.

**4. What makes a finding "blocking"?**
`severity === 'critical' && certainty === 'deterministic'`.

Blocking is derived, never stored — storing it would let two code paths disagree about the same
finding. Probabilistic findings never block on their own: §7.3 forbids presenting ambiguous
categories as facts without user review, and §17.1 requires **zero** clean control files to be
assigned a blocking deterministic finding. A probabilistic critical finding is still shown, still
severe, still reaches the user; the product simply does not assert as fact that sharing must stop.

What blocking means operationally: a loud signal that sharing should not proceed without action. It
does **not** authorise acting automatically — §5.5 requires review before mutation and §9.3 forbids
hidden bulk actions.

**Cancellation.** A cancelled run stopped before it was done, so it can never be `no_findings` —
whether or not any detector got as far as recording a `cancelled` skip. The `cancelled` flag on the
result is read directly, because a run can be stopped between detectors and leave the coverage arrays
looking complete. §12.1 makes the same demand of the CLI: cancellation must not leave something that
looks successfully processed.

**5. Zero findings with a non-empty `coverage.skipped` — can that be `no_findings`?**
Only when every skip is benign. `not_applicable_to_media_type` is benign: a PNG has no EXIF block,
and calling that incomplete would make every clean image `partial` and train users to ignore the
state. Every other skip reason reduces coverage, including `disabled_by_user` — the user chose not to
run it, but the check still did not happen, and §5.3 forbids silent safety claims.

The classification lives in `status-inputs.json`, and the build fails if a skip reason is added
without one.

## Exit-code decision table

Evaluated top to bottom. The order runs outward-in: things that stop the command before it touches
the file, then things that put the file out of scope, then things that went wrong, then completeness.

| # | Condition | Code | |
|---|---|---|---|
| 1 | arguments rejected before any file was opened | `2` | invalid arguments |
| 2 | output path resolves to the input, or escapes via a symlink | `7` | unsafe output path |
| 3 | a confirmation-required action was requested without approval | `8` | approval required |
| 4 | media type outside the supported set | `3` | unsupported input |
| 5 | the run could not complete | `5` | processing failure |
| 6 | a verification stage returned `still_present`, `unable_to_verify` or `failed` | `6` | verification failure |
| 7 | any detector failed or was skipped for a coverage-reducing reason | `4` | partial inspection |
| 8 | otherwise | `0` | completed, result available |

### The four remaining conflicts in §12.2

**`partial` plus a blocking finding — exit 4 or 0?**
**4.** An inspection that did not look everywhere is a partial inspection regardless of what it did
find. Deriving the exit code from the status would have made this case exit 0 and silently broken
every script that checks for incomplete scans.

**Which code does `blocking_findings` map to?**
`0` or `4`, depending only on coverage. It is the only status with two possible exit codes, and the
test suite pins that.

**`5` vs `6`.**
`5` is the run failing. `6` is the run succeeding and reporting that the removal was not confirmed —
a verification result of `still_present` or `unable_to_verify` is an answer, not a crash. §10.2
forbids collapsing `unable_to_verify` into success, so it exits 6.

**When is `8` produced, given the CLI does not do approvals?**
When a mutation is requested that §9.1 marks as needing explicit confirmation — removing annotations
or embedded files, clearing form values, applying redaction — and that approval was not supplied on
the command line. The CLI does not prompt (§12.1 forbids prompting in JSON mode), so it refuses and
says why. The same code is what a guarded MCP workflow returns when the host has not approved.

**`3` and `4` cannot both apply.** An unsupported media type means no detectors run, so there is no
partial coverage to report. They are mutually exclusive by construction, not by precedence.

**Exit code `1` is deliberately unused**, so that an uncaught crash — which most runtimes report as 1
— is never mistaken for one of these defined outcomes.

## Status / exit-code matrix

| Status | Possible exit codes |
|---|---|
| `no_findings` | `0` |
| `review_required` | `0` |
| `blocking_findings` | `0` or `4` |
| `partial` | `4` |
| `unsupported` | `3` |
| `failed` | `5` |

## Scope is derived, never supplied

Whether a media type is in scope is a fact about the file, read from `input.mediaType`. There is no
caller override — not even an optional one. An optional override is not a weaker version of the
problem it was meant to solve; it is the same problem with a default, and the three interfaces can
still disagree by passing different flags.

The only fact the rules accept from outside is `unusable` — a run that died before producing anything
coherent, which by definition cannot be read off the result it failed to produce.

## How these rules are kept honest

- The status of every committed example is **computed**, not declared: `npm run validate` fails if an
  example's `status` field disagrees with what the rules produce.

  Note what this does and does not prove. It proves the examples and the rules agree; it does **not**
  independently verify the rules, because a wrong rule and an example written to match it would agree
  just as well. The independent check is the named cases in `tools/test-status.mjs`, whose expected
  statuses are written by hand from the case study's requirements rather than derived from the
  implementation.
- The test suite enumerates the cross product of coverage state, skip reason, detector failure,
  severity, certainty, cancellation, media type and run outcome — 2240 combinations — and requires
  every one to produce exactly one defined status with a stated reason. There are no undefined cells.
- Every status value must be reachable; an unreachable value would mean a rule above it had swallowed
  its cases.
- An unclassified skip reason throws rather than defaulting to benign.

## Not decided here

The CLI's argument parsing, output formatting and the actual `--approve` flag names belong to #9
(E8). This document defines what the codes mean, not how the command line spells them.

One acceptance criterion from #24 moved to #9 for the same reason: verifying that a `--json` run's
exit code does not contradict the JSON on its stdout needs a real process to observe, and there is no
CLI yet. The semantics it will be checked against are here.
