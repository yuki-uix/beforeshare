# Path safety gate

Rules: [`schemas/v1/path-rules.json`](../../schemas/v1/path-rules.json).
Reference implementation: [`tools/path-gate.mjs`](../../tools/path-gate.mjs).
Run `npm run test:path-gate`.

§13.4: *"Symlinks and path traversal must be resolved and checked before access or writing."*

That is a statement about **every** access. A check applied at each call site is a check that
eventually is not applied at one of them, and the missing one looks exactly like the others until it
matters.

## The gate cannot be bypassed

`readFile` and `writeFile` accept only a `ResolvedPath`, and the gate records which objects it issued
in a `WeakSet`. A caller holding a plain string has no way to reach the filesystem.

The brand started as a symbol property on the object, which was wrong: object spread copies symbol
keys, so `{ ...readPath, mode: 'write' }` carried the brand and turned a read authorisation into a
write one — the exact substitution `mode` exists to prevent. Membership does not copy, and issued
paths are frozen, so neither a copy nor an edit survives.

This is why the module exists, and it is the property to preserve if the gate is reimplemented in the
core's eventual language: forgetting the gate should fail to compile, not fail in review. A
hand-built path object is rejected at runtime here, and the vectors pin that.

`forRead` and `forWrite` produce different modes, and each function checks the one it needs — a path
resolved for reading cannot be written, which stops a read authorisation from becoming a write.

## Two paths, one file

macOS makes this ordinary rather than exotic:

- **APFS is case-insensitive by default.** `Report.pdf` and `report.pdf` are one file.
- **The filesystem stores NFD; applications commonly produce NFC.** An accented filename typed in one
  place and read from another is two different strings naming one file.

So identity is compared after Unicode normalisation and case folding, never as raw strings. Comparing
strings would let a different spelling of the input pass as a different file — which is precisely how
an output path ends up on top of its input, the case §12.1 singles out.

The vectors cover all four spellings of the same collision: identical, case-different,
normalisation-different, and reached through `..` or a symlink.

## What is refused, and when

| Reason | Stage | |
|---|---|---|
| `not_absolute` | before access | a relative path resolves against a directory the caller does not control |
| `empty_or_null_byte` | before access | a NUL truncates the path in C APIs, so the string checked and the string opened differ |
| `traversal` | before access | `..` escaping above the root, checked after collapsing |
| `symlink_escape` | before access | a link anywhere in the path, including a directory component |
| `outside_authorised_roots` | before access | §13.4 forbids requesting unrestricted filesystem access |
| `output_is_input` | before write | §12.1, compared after full resolution and identity normalisation |
| `output_is_directory` | before write | named rather than left to the filesystem to report late |
| `symlink_loop` | before access | a cycle has no target; a resolver that stopped after N hops would hand back an intermediate path and call it resolved |
| `unresolvable` | before access | the filesystem could not answer — a permissions failure on a directory component, say. Absence is not this: an output path naming a file that does not exist yet is ordinary |

Every stage is `before_*`, and the validator enforces that: a reason that could only be detected
after opening the file would be describing a check that runs too late to satisfy §13.4.

A root is matched the same way any other path is — after normalisation and case folding — so an NFC
root authorises an NFD path naming the same directory, and a differently-cased spelling of the root
is the same root.

A relative root is refused at construction. Accepting one produces a gate that builds and then
refuses everything, with each refusal naming the path rather than the root that is actually
misconfigured — a failure that reads as "this file is not allowed" when it means "the configuration
is wrong".

A gate with no authorised roots is not constructible, and neither is one rooted at `/`. Those two
authorise exactly the same thing, so refusing only the empty list would have left §13.4 satisfiable
by spelling — which it was, until a review found it.

## A missing leaf is not a missing check

`realpath` on a path whose leaf does not exist throws `ENOENT` and says nothing about the directories
above it. An output path naming a file that does not exist yet is ordinary, so the first version
treated the lexical path as the answer — which is an authorisation bypass:

```
<root>/evil/new.pdf    where evil is a link to /etc
```

is lexically inside the root and actually is not. The gate issued a write authorisation, and the
write would have landed in `/etc`.

The gate now resolves the nearest **existing** ancestor and appends the missing tail to its real
location, then checks that. Walking back only one level is not enough: several levels can be missing
at once, and stopping at the first absent directory learns nothing about a link above it. Both the
single-level and multi-level cases have vectors, and the mutation that walks back one level fails.

## The check and the access must reach the same file

`resolve` checks the path it was handed. If the access then passes that string to the filesystem, the
string is resolved a second time — and a component replaced in between is followed. Reproduced: with
`<root>/sub/a.pdf` resolved while `sub` was a real directory, replacing `sub` with a link to `/etc`
afterwards made the read return `/etc/a.pdf`.

So `forRead` and `forWrite` take a handle at resolution time, and `readFile` and `writeFile` use the
handle rather than the path. §13.4's guarantee is about where the bytes come from, not where they
came from a moment ago.

A filesystem that offers no `open()` falls back to passing the path, and `bindsToHandles(fs)` reports
which behaviour a build has. A caller that needs the guarantee can ask instead of assuming, and the
vectors assert both shapes — including that the unbound one really does follow the replacement, so
the weaker mode is documented by a test rather than by silence.

## Case folding follows the volume

`caseInsensitive` was a constant. On a case-sensitive volume that makes `/ROOT/secret` count as
inside `/root` — an authorisation decision taken with the wrong comparison. APFS is case-insensitive
by default but can be formatted either way, so the gate probes the filesystem and the rule table
carries only a default.

The probe is **per root**. Roots can sit on volumes with different rules, and one rule applied to all
of them is wrong for some. Until the interface can carry a rule per root, a mixed set is refused at
construction rather than quietly resolved to one of them.

## The stub is checked against the filesystem it stands in for

Vectors run against an injected filesystem, because symlink layouts are awkward and sometimes
impossible to create on disk. That only works while the stub behaves like the real thing, so the
suite creates a temporary directory with a real link and a real cycle, and asserts that `node:fs` and
the stub agree on four behaviours: absence throws `ENOENT`, a cycle throws `ELOOP`, a link
dereferences to its target, and a **relative** target resolves against the directory holding the
link. The stub resolved relative targets as if they were absolute until a review pointed out that no
filesystem does — the vectors had agreed with it.

The first version of this module documented `realpath` as returning `null` on absence. No filesystem
does that, and every vector ran against the stub that did — the checks agreed with each other and
with nothing else.

## How the rules are kept honest

- The rule table is data, and the validator checks the implementation exposes exactly the reasons the
  table declares — in both directions.
- Every declared reason must be triggered by at least one vector. A reason that no vector reaches is
  a rule nobody has shown the gate can enforce.
- Eleven mutations were run against the implementation — removing case folding, removing
  normalisation, skipping symlink resolution, dropping the root check, defeating the brand, comparing
  paths as raw strings, allowing `/` as a root, making the brand copyable again, not freezing issued
  paths, swallowing `ELOOP`, and treating every `realpath` failure as absence — and each was caught by
  the vector written for it.

## Not decided here

| Question | Owner |
|---|---|
| Carrying a distinct case rule per authorised root instead of refusing mixed sets | #3 — needs the interface to hold a rule alongside each root |
| An `open()` that refuses to follow a symlink at the final component, so the unbound fallback is not merely narrower but safe | #37 — it lands with atomic write |
| Collision-safe output names once a destination is accepted | #36 |
| What the gate does when a path becomes invalid mid-run | #37 |
| Whether the core's language can make a forged path fail to compile rather than at runtime | E2 (#3) — it belongs with the gate, and waits on the core language ADR |
