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

## Temp beside the destination, then rename

A rename is atomic within one filesystem and not across them. A temp file elsewhere degrades
silently into a copy, and a half-copied file wearing the destination's name is the thing §12.1 says
must never appear. The temp path is refused when it is not in the destination's directory.

**The temporary file is a path being written**, so §13.4 applies to it exactly as to the
destination: it is a *different name* from the one that was checked, and a symlink planted at
`<destination>.part` would otherwise be followed — the bytes land wherever it points and the rename
then moves something else into place. It goes through the gate.

The temporary name is also claimed exclusively. Writing to it unconditionally
would destroy another run's half-written file — the collision the destination is
careful about, one name over.

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
| What happens when the write is cancelled or the process dies between claim and rename — the claimed empty file survives | #37 — it owns cancellation, crash and write-failure semantics |
| How long the temporary file lives, what permissions it carries, and who else can read it | #38 — the temp file's lifetime and side channels are its subject |
| Arbitration when two runs want the same input, beyond the naming race closed here | #40 — this settles the name, not the work |
| Whether a claimed-but-unwritten name should be released, and how that interacts with a retried run | #37 — releasing it is only meaningful once failure has a defined shape |
| Disk-full and permission failures during the temp write | #37 — §20.2 lists them with the other write failures |
| A claimed temporary name left behind by a dead run blocks the next one forever | #37 — reclaiming it needs failure to have a defined shape first |
