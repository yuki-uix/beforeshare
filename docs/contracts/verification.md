# Verification contract

Schema: [`schemas/v1/verification-result.schema.json`](../../schemas/v1/verification-result.schema.json).
Examples: `verification-verified.json`, `verification-unable.json`.

§10 opens by saying verification must be treated as a product feature, not a success toast. This
schema is built around the two ways that goes wrong: a verifier that only asks the code that wrote
the file, and a result that presents "we could not check" as "it is fine".

## The five outcomes, and where the lines are

| Outcome | Meaning | Successful? |
|---|---|---|
| `verified_removed` | The target is absent from every surface an independent reader examined | yes |
| `verified_transformed` | The action deliberately replaced the content, and the original is not recoverable from any examined surface | yes |
| `still_present` | An independent reader still finds it | no |
| `unable_to_verify` | No independent reader could answer the question | no |
| `failed` | The verification stage itself errored | no |

**`verified_removed` vs `verified_transformed`** — both require the original to be unrecoverable; the
difference is whether anything took its place. Deleting a metadata field removes it. Rasterising a
redacted region, or flattening annotations into the page, transforms: something is now there that was
not before, and the user's file changed shape in a way they should be told about even though the
outcome is successful.

**`unable_to_verify` vs `failed`** — `unable_to_verify` is an answer: the check ran and could not
reach a conclusion, and `unverifiableReason` says which of five ways. `failed` is the verifier
crashing. §10.2 forbids collapsing `unable_to_verify` into success, and the schema enforces the two
consequences: a successful outcome may not carry an `unverifiableReason`, and `unable_to_verify`
must carry one.

## Independence is recorded, not assumed

§10.1: *"Using the same function to write and then assert its own internal state is insufficient."*

Every result lists its `readPaths`, and each one declares a `role`:

- `independent` — shares no parsing or serialisation code with the component that produced the output
- `shares_writer_implementation` — does, so its agreement proves nothing on its own

**A successful outcome requires at least one `independent` path.** The schema rejects
`verified_removed` or `verified_transformed` backed only by readers that share the writer's code.
This is the one place §10.1's demand becomes mechanical rather than aspirational — and it has to be
mechanical, because the failure it guards against looks exactly like success from the inside.

Three `unverifiableReason` values mean nothing was examined at all — the output could not be
reopened, no independent reader exists for the action, or no verifier covers it. The schema forbids
those results from naming a surface, in `surfacesChecked` or on a read path. An example here recorded
`raw_objects` beside a message saying the file could not be opened, which is a failed attempt
counted as coverage.

`surfacesChecked` records which of the surfaces §10.1 enumerates were actually examined — raw
objects, extracted text, rendered pages, metadata blocks, annotations, attachments, image pixels.
Without it a check of one surface reads identically to a check of all of them.

The seven surfaces are defined once, in `common.schema.json`, and referenced by everything that uses
them: a capability's verifiable surfaces, a read path, and this list. They first existed as four
inline copies that agreed by copy-paste. The fix was not a check that the copies match — that accepts
the duplication and then polices it — but removing the duplication, which leaves only one failure
mode: someone pasting a copy back. That is what the validator now looks for.

## Preservation is measured, not asserted

§10.3 asks for a render comparison "within an explained tolerance". A boolean pass/fail would hide
what was measured and leave nothing to argue with, so every preservation entry carries a named
`metric`, the `measured` value, and the `tolerance` it was judged against.

| Check | Metric |
|---|---|
| page count | `page_count` |
| page dimensions | `page_dimensions_pt` |
| visible render | `pixel_difference_ratio` |
| text outside approved regions | `text_recall_ratio` |
| image dimensions and orientation | `image_dimensions_px`, `orientation` |
| output readability | `readability` |

§10.3 lists five bullets; there are six keys here because its first bullet — "page count and
dimensions" — covers two things that can fail independently. A document whose pages were resized but
not lost, or lost but not resized, are different defects, and one combined key could only report the
worse of them. The split is deliberate; it is noted because counting the schema against the clause
otherwise looks like a discrepancy.

All six keys are required whether or not the check ran. A missing key would be indistinguishable from
a check that passed. A check that did not run must set `checked: false` and give a
`notCheckedReason`, and may not claim any outcome other than `not_checked`.

## Success is defined in code

[`tools/verification.mjs`](../../tools/verification.mjs) exports the two successful outcomes and a
`summariseVerification` that decides whether a whole run may be called successful. §10.2's two
sentences — only the first two outcomes succeed, and `unable_to_verify` must not be collapsed into
success — were prose until that file existed, and prose is not something three interfaces can be
checked against.

There is no partial credit. A run where one action verified and another came back
`unable_to_verify` is not a successful run, and neither is one where a preservation check found a
change beyond its tolerance.

## Stage binding

`original` and `sanitized` each carry a SHA-256. §14.1 requires file hashes to bind inspection,
remediation and verification; a verification whose original hash no longer matches the inspection it
cites is verifying a different file, and the hashes are what make that detectable.

`results` has one entry per entry in `requested`, **in the same order**. This is a hard requirement,
not a convention: `summariseVerification` compares the two by index. A set comparison was the first
implementation and it let one result answer two requests — `requested` has no `uniqueItems`, and two
findings each asking for a metadata removal is a normal case — so a run was reported successful with
an action never verified.

`requested` is the action list the caller states was applied. Verification answers that list — it
does not discover what happened. An action performed but not declared is not verified, and nothing in
the result will say so, which is why the CLI and MCP contracts require the caller to pass it.

## Not decided here

| Question | Owner |
|---|---|
| Which readers actually satisfy `independent`, and how the build keeps their dependency graphs disjoint from the writer's | E7 |

This schema defines what has to be recorded; it cannot by itself stop someone labelling a shared
reader as independent.
