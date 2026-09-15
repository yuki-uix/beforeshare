# Immutable output and collision-safe naming

§5.2 makes originals immutable; §9.3 forbids in-place overwrite and forbids deleting the original
after a successful export. §11.1 asks for collision-safe filenames. This records how those hold, and
what they do not cover.

## The question is not "may we write here"

It is "which name did we manage to reserve".

Asking whether a name is free and then writing to it leaves a window. Another process asks the same
question in that window and gets the same answer, and one of the two results is silently lost —
§20.2 lists *concurrent requests for the same input and output* as a boundary that must be tested,
and a check-then-write cannot pass it however carefully it is written.

So the name is claimed by **creating it exclusively**. The creation is the reservation, and the loop
steps to the next candidate when the create fails. A vector simulates losing the race and asserts
both that the next name is taken and that the other process keeps what it wrote.

## The marker goes before the final extension

`report.pdf` → `report (sanitized).pdf` → `report (sanitized) 2.pdf`

| Case | Result | Why |
|---|---|---|
| no extension | `report (sanitized)` | nothing to sit in front of |
| leading dot | `.bashrc (sanitized)` | a leading dot is the name; treating it as an extension yields ` (sanitized).bashrc`, a different file |
| two extensions | `archive.tar (sanitized).gz` | stated, not solved — the §8.1 media types all carry one |

## The original cannot be resolved for writing by omission

`forWrite` used to take `{ input }` optionally. Omitting it meant "no input to
collide with" — which is the same shape as forgetting it, and forgetting it
skipped §12.1's refusal entirely: a caller could resolve the original for
writing and overwrite it. §17.3 allows **0 cases** of a workflow changing the
original, so the whole guarantee rested on every call site remembering.

The key is required now. A write genuinely not derived from an input passes
`input: null` and says so. A default reachable by omission is not a decision.

Only `null` states that. `undefined` passes a key check and would skip the
refusal again — the same hole, reached by forwarding a missing optional argument
rather than by omitting the key — so anything else must be a ResolvedPath the
gate issued.

## The reservation is the temporary file; the publish is a link

Reserving the destination with an empty placeholder and renaming over it later
cannot be made safe without handles. Between the placeholder and the rename,
another process can delete it and put its own file there — and an ordinary
rename replaces that file without noticing, which is §9.3's silent overwrite
arriving through the back door. Re-reading the path first only narrows the
window; it does not close it.

So the destination is never created early. The temporary file is the
reservation, created exclusively beside the destination, and the destination
comes into existence at publish by a **link**, which refuses an existing name
atomically. A name taken after the claim is stepped over, not replaced.

| | |
|---|---|
| reserve | the first `<candidate>.part` this process can `createExclusive` — gated first, so a link planted there is refused as an escape before any work is done |
| write | into the temporary file |
| publish | `link(temp, destination)`, advancing to the next candidate on refusal, then `unlink(temp)` |

Every candidate carries its own temporary name, and the run starts from the one
it reserved. Tying the reservation to the first candidate alone stopped a second
run from starting at all while the first was writing — its temporary name was
taken and every free name behind it was unreachable, which is §20.2's concurrent
case failing in the other direction. An explicit path has one candidate and
nowhere to step to, so a busy temporary name is the answer rather than a detour.

The temporary name is derived rather than supplied, so it is always beside the
destination — a link only works within one filesystem, and a temporary file
elsewhere would fail at publish with all the work already done. That retired
`temp_outside_destination_directory`: nothing can express the violation now, and
a rejection reason nothing can reach is a claim about enforcement that does not
happen.

The stub these vectors run against is compared with `node:fs` on a real
temporary directory: exclusive create on a free name, an existing file and a
symlink; that a refused create left the link pointing where it did; and that a
link onto a free name publishes while a link onto an occupied one refuses and
leaves the occupant alone. This repository has been wrong about a filesystem's
behaviour before — `realpath` was documented as returning null for a missing
path, which nothing does, and every vector ran against the stub that did.

## What a path-based claim still cannot promise

`createExclusive` takes a path. A parent component swapped between the gate's
check and the create can still land outside the authorised roots. Closing that
needs handle-relative primitives — open the directory, create relative to the
handle, never follow a link — which this reference implementation does not have.
It is the same handle question the gate already carries, and it is recorded
below rather than described as solved.

## A rule nobody reads is decoration

Being allowed to exist is not being read. `naming.extensionRule` said
`last-dot` beside a `splitExtension` that hard-codes it, and changing the string
to nonsense changed nothing — the table read as the specification while the code
ignored it.

Every leaf in a rule table must now be read by its module or asserted by the
validator. Fields that are genuinely explanation are declared as prose, and then
checked for being prose, so a rule cannot leave through that door by being
relabelled.

The check nearly passed vacuously itself: it searched the validator's source,
and the comment explaining the rule contained the rule's name. Comments are
stripped from both sides first.

## What the exhaustive action test proves, and what it does not

Issue #36 asks for every remediation action, not a sample, so the list is
`enums.schema.json`'s `remediationAction` enum: a ninth action joins without anyone remembering, and
a renamed one fails the count.

**But running one write path eight times is eight copies of one check.** No format adapter exists
yet, so the eight differ only in the bytes handed over. The immutability does not come from those
eight passing — it comes from there being exactly one place in the module that writes, which is
what a ninth action cannot weaken. That is asserted directly: a second writing path anywhere in the
module fails the suite, and the assertion itself is checked against finding no writers at all.

## Not decided here

| Question | Owner |
|---|---|
| What happens when the write is cancelled or the process dies between the claim and the publish — the temporary file survives and holds its name | #37 — it owns cancellation, crash and write-failure semantics |
| How long the temporary file lives, what permissions it carries, and who else can read it | #38 — the temp file's lifetime and side channels are its subject |
| Arbitration when two runs want the same input, beyond the naming race closed here | #40 — this settles the name, not the work |
| Whether a claimed-but-unwritten name should be released, and how that interacts with a retried run | #37 — releasing it is only meaningful once failure has a defined shape |
| Disk-full and permission failures during the temp write | #37 — §20.2 lists them with the other write failures |
| A publish whose `unlink` of the temporary file fails, leaving a second hard link to the same bytes | #37 — it owns what a partial failure leaves behind |
| A temporary file left behind by a dead run blocks that destination name forever | #37 — reclaiming it needs failure to have a defined shape first |
| A parent directory component swapped between the gate's check and the exclusive create | #34 — the gate owns handles, and handle-relative creation is the only thing that closes it |
