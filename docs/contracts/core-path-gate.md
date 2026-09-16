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

## What the review found, and what class each belonged to

Eight findings, and only two were about code this port introduced. The rest were
defects the port carried over or that its own fixes created:

| Finding | Class |
|---|---|
| `write_file` opened by name and followed a link planted at the final component | the read side's defect, unfixed on the write side — the handle cannot be taken at resolve time for a file that does not exist yet, so `O_NOFOLLOW` at open is what refuses |
| `folds_case` could not report a case-sensitive volume at all | the "could not tell" arm swallowed the answer: on such a volume the swapped spelling never resolves, and that IS the answer, not a failure to probe |
| `identity_key` composed before folding | the composition table holds only lowercase base characters, so `CAFE\u{301}` stayed decomposed and no later lowercasing could compose it |
| a root spelled `/.` canonicalised to `/` | the refusal was written against the spelling, so the rule was satisfiable by spelling — the same hole as refusing `["/"]` but accepting `[]` |
| a second `read_file` on one authorisation returned nothing | a duplicated descriptor shares its offset; an empty result reads as an empty file rather than as a mistake |
| the compile-fail probe hard-coded `target/debug/deps` | it is `<target>/<profile>/deps`, and `--release` or `CARGO_TARGET_DIR` made the probe panic |
| the unreadable-directory vector asserted a refusal a privileged process never gets | a case that stops testing anything wherever it runs privileged |
| the guard matched with `printf \| grep -q` under `pipefail` | the job beside this one carries a comment about exactly this SIGPIPE trap; the lesson had not travelled |

A ninth arrived in the next round and is the sharpest of them: **a comparison
used to authorise must be exactly as lossy as the volume, and never more.**
`identity_key` normalised Unicode for every comparison, including the one
deciding whether a resolved path is inside an authorised root. Case is probed
per volume; normalisation was not probed at all. On a byte-preserving
filesystem `/x/caf\u{e9}` and `/x/cafe\u{301}` are two real directories, and one
key for both meant a directory outside the root compared equal to the root.

The keys are separate now. `containment_key` folds case by the probed rule and
does not normalise — both its callers compare paths `canonicalize` has already
returned, which is the filesystem's own answer about spelling. `spelling_key`
still normalises, because it reads the caller's own untouched spelling and
decides only *which* refusal to report; a wrong answer there is a misleading
message, not an authorisation.

This one could not be caught by a vector on this machine: APFS refuses to hold
both spellings at once, so the bypass is unreachable on macOS and reachable on
ext4. It is asserted on the two key functions instead.

An eleventh, in the round after that, was **caused by the fix for the second**.
Reading "the swapped spelling does not resolve" as *case-sensitive* is right
only if the swapped spelling names the same volume — and `folds_case` flipped
every component, so a case-insensitive mount under a case-sensitive ancestor
failed to resolve for a reason that had nothing to do with it. Before the fix it
guessed permissively; after, it guessed the opposite. Only the last component is
flipped now, and a name with no ASCII letter is refused rather than compared
with itself.

That is this repository's recorded pattern arriving on schedule: *several
defects here were introduced by the fix for the previous one.* Fixes are the
least reviewed code in a pull request, because each round reads them for the
first time.

The last one is worth naming separately: the guard job next to this one already
documents that trap in a comment, and this PR reintroduced it a few hundred
lines away. A comment is not a check.

## One question this port answered by having a type for it

Both handoff tables listed "who closes a handle, when, and what happens on an
error path" as open. In the core it is not: the handle is an `OwnedFd` owned by
the `ResolvedPath`, so it closes when that value is dropped, on the error path
as on the ordinary one, with no `Drop` written here and nothing to forget.
`read_file` reads through a `try_clone`, which closes at the end of the read.

What remains open is a policy rather than a mechanism — how long a process
should hold a handle, and whether one is kept across stages — and the rows say
that now. A table that lists a decided question as open is the same defect as an
example that violates the rule it illustrates: it reports work that does not
exist.

## A finding whose premise did not hold, and what it was still worth

A later round argued that `canonicalize` on macOS does not rewrite case or
normalisation to the on-disk spelling, so comparing canonical strings could miss
an output that is its own input. Measured on APFS, it does rewrite both:

```
asked REPORT.PDF            -> report.pdf
asked 63 61 66 65 cc 81     -> 63 61 66 c3 a9      (NFD in, the stored NFC out)
```

So the stated reason was not the reason. The change it suggested was still worth
making, for a different one: the gate is already holding the input's handle, and
asking the filesystem through that handle settles identity without any
assumption about spelling at all - and without re-opening the input by a name
that may have been repointed since it was authorised. A hard link is the case no
comparison of names can see, and it now has a vector.

The write vectors also only ever asserted refusals, so a `write_file` that
returned `Err` for everything satisfied all of them. There is a vector for the
bytes landing now, and one for them replacing rather than appending.

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
| A root whose name carries no ASCII letter (`~/\u{6587}\u{6863}`) cannot be probed for its case rule and is now refused | #62 — the name experiment is a stand-in; the real answer is asking the volume (`getattrlist` / `ATTR_VOL_CAPABILITIES`), which needs FFI this crate forbids today |
| How long a process should hold a handle, and whether one is kept across stages | #38 — a lifetime policy, not a closing mechanism; it belongs with temporary-file lifetime |
| Carrying a distinct case rule per authorised root instead of refusing mixed sets | #3 — needs the interface to hold a rule alongside each root, which is an E2 interface decision |
| Whether `cargo test` on a byte-preserving volume is a supported configuration or merely tolerated | #62 — the vectors assert both answers today; committing to one is a packaging decision this slice does not own |
