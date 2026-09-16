# The path gate in the core

The reference implementation in `tools/path-gate.mjs` states the rules; this
records what changes when the same rules are held by a type system instead of by
a convention, and what did not change. ADR 0001 chose Rust for the core on the
strength of three claims. This is the first of them, and the first place they
can be checked rather than argued.

## The claim, and the form the evidence takes

`ResolvedPath` has private fields. A path the gate never issued cannot be
constructed, so `read_file` cannot be reached with one. In JavaScript that was a
`WeakSet` consulted at runtime, and the check had already been bypassed once —
the brand was a symbol property, and object spread copies symbol keys, so
`{ ...readPath, mode: 'write' }` turned a read authorisation into a write one.

The evidence is `core/tests/compile_fail.rs`: two programs that must not build,
each asserted to fail with **E0451**, the "private field" error. Asserting only
that they fail would accept a typo as proof — and did, briefly: the first
version compiled the probe to `/dev/null`, so a program that *did* build still
exited non-zero and the "must not compile" assertion passed anyway. The mutation
that makes the fields public caught it.

## What the port found in the rules it was copying

Porting is not a translation exercise if the vectors are rewritten against a
real filesystem rather than a stub. Two defects surfaced that both
implementations had:

**A dangling symlink escaped the authorised roots.** `realpath` reports ENOENT
for a link whose target does not exist, exactly as it does for a missing file.
The resolver treated that as "a file that does not exist yet", rejoined the
name to its resolved parent, and dropped the link — so a link pointing anywhere
outside was authorised under its own in-root name, and the write landed at the
target. Neither suite could express the case: the filesystem contract had no way
to report a link target, so `readlink` is now part of it, checked at gate
construction rather than discovered at whichever path first needs it.

**A read the gate could not open was authorised without a handle.**
`open_nofollow(..).ok()` made the handle optional and `read_file` fell back to
opening by name — so the single case `O_NOFOLLOW` exists for, a link at the
final component, degraded into following that link. A read authorisation now
carries its handle or is refused.

## What the mutations found in the vectors

Four cases were written because a mutation survived, and each survivor looked
like coverage:

| Mutation that survived | Why the vectors could not see it |
|---|---|
| case folding removed | `canonicalize` folds case itself for a path that exists, and every vector used an existing file |
| Unicode normalisation removed | same: it composes the name on the way back |
| `O_NOFOLLOW` removed | by open time the path is canonical, so its final component is never a link except in the race the flag exists for |
| the mixed-volume refusal removed | it needs two volumes with different case rules, which one machine does not have |

The first two are now reached through the one place the caller's own spelling is
judged — deciding whether a path that ended up outside the roots was ever inside
them. The third is tested on the function. The fourth is split into a probe and
a decision, and the decision is tested directly.

A fifth mutation survived for a better reason: it landed on a self-reference
check that `canonicalize` reaches first with ELOOP, so the check could not run.
The code is gone. That is what a mutation that cannot be killed usually means,
and the mutation applier now refuses any mutation matching more than one site,
because this one matched two identical lines and hit the dead one.

## What did not change

The rules are still data. `schemas/v1/path-rules.json` is `include_str!`'d, not
copied, and `Rejected::all_reasons()` is compared against the table's own
declarations in both directions — a reason in the enum that the table does not
declare, and a reason the table declares that no vector can reach, each fail.

## Not decided here

| Question | Owner |
|---|---|
| A parent component swapped between check and open: `O_NOFOLLOW` covers the final component only, and closing the rest needs a component-by-component `openat` walk | #62 — a later slice of the same port, once the gate has a directory-handle type to walk with |
| Whether the JavaScript reference implementation is retired once the core owns these rules, or kept as a second opinion | #3 — E2 owns what the reference implementations are for |
| Who closes a handle, when, and what happens on an error path | #38 — unchanged by this port; it belongs with temporary-file lifetime |
| Carrying a distinct case rule per authorised root instead of refusing mixed sets | #3 — needs the interface to hold a rule alongside each root, which is an E2 interface decision |
| Whether `cargo test` on a byte-preserving volume is a supported configuration or merely tolerated | #62 — the vectors assert both answers today; committing to one is a packaging decision this slice does not own |
