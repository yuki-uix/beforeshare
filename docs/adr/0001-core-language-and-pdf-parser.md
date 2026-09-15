# ADR 0001 — The core's language, and the PDF parser under it

**Status:** accepted
**Date:** 2026-09-15 (proposed and accepted the same day, by the repository owner)
**Supersedes:** nothing. **Unblocks:** #4 (E3), #5 (E4), and the contract questions listed below

---

## Why now

E1 and E2 both deferred this, and both could: schemas are language-agnostic JSON, and the safety
rules turned out to be expressible as data plus a reference implementation in `tools/*.mjs` that
touches `node:fs` and nothing else.

E3 cannot defer it. A PDF checker needs a PDF parser, and a parser is a language-bound dependency
whose behaviour would be encoded into the rules the moment a reference implementation exists.
"Which objects count as annotations", "how an incremental update is traversed", "what a malformed
xref does" are answers a parser gives, not answers a rule states — and the first parser to answer
them sets the shape of everything after it.

§14 draws format adapters *under* a core API. Nothing has yet said what the core is. That hole is
about to start carrying weight.

## What the requirement actually constrains

The case study does not prescribe a language (§14). It does constrain the runtime, and E2 turned
several of those constraints into working code, which is the useful part: the interface the
reference implementations demand is now a specification.

**The filesystem operations the core must have.** Taken from what `tools/*.mjs` call, not from a
wish list:

| | why it exists |
|---|---|
| `realpath` | §13.4 — symlinks and traversal resolved *before* access |
| `open` + handle-relative read/write | the check-to-use window; a path re-resolved at access time follows a component replaced in between |
| `createExclusive(path, {mode})` with `O_EXCL` | reserving a name is the reservation; `0600` at creation, because a file created readable is readable for the whole window someone waiting needs it |
| `link` | the publish must refuse an existing name **atomically** — a rename replaces, and a replaced file is §9.3's silent overwrite |
| `unlink`, `rename`, `list` | cleanup, registry replacement, and the sweep finding its own candidates |
| `isCaseInsensitive` per volume | APFS is case-insensitive by default and formattable either way; assuming one answer for every root is CWE-863 |
| process liveness (pid + start time) | an orphan is proved, not guessed; a recycled pid either keeps an orphan for ever or deletes live work |

**Two capabilities the reference implementation does *not* have**, and which are recorded as open
in the contracts:

- **handle-relative creation** (`openat` + `O_NOFOLLOW`). `createExclusive` takes a path, so a parent
  component swapped between the gate's check and the create can still land outside the authorised
  roots. Closing it needs the directory held open and the child created relative to it.
- **durability** (`fsync` on the file before the link, on the directory after). `link` makes the
  directory entry appear in one step; it says nothing about when bytes reach the disk, so §17.5's
  claim is currently narrowed to process death rather than power loss (#53).

Both are POSIX-level. Any candidate that cannot reach them inherits a permanent asterisk on two
safety claims.

**What §11.1 and §22 add.** A native-feeling macOS app with Finder Quick Action and "Open with",
code-signed and notarized. That is a constraint on the *desktop shell*, not necessarily on the core —
but a core the shell cannot embed cheaply pushes the cost into an IPC boundary that §14's diagram
does not have.

**What §14.1 forbids.** Three interfaces, no divergent detection logic. Whatever the core is, the
CLI, the desktop app and the MCP server must all call it rather than reimplement it — which rules
out "the CLI is a script and the app is a rewrite".

## Candidates

Judged against the constraints above, not against general merit.

### Rust

- **POSIX reach**: complete. `openat`/`O_NOFOLLOW`/`fsync` are `rustix` or `nix` calls; the two open
  capabilities close.
- **Type-level enforcement**: the strongest on offer, and it is not decorative here — E1's second
  acceptance criterion ("`partial` cannot be treated as `no_findings` **at the type level**") is
  currently only met behaviourally, and the path gate's `ResolvedPath` brand is a WeakSet standing in
  for a type that cannot be forged. Both become compile-time facts.
- **Embedding**: a static library the macOS shell links, and a CLI binary, and an MCP server, from
  one core. §14.1's "no divergent logic" is cheapest here.
- **PDF parsers**: `lopdf` (low-level object access, which is what §7.1 mostly needs), `pdf-rs`,
  or bindings to MuPDF/PDFium. Object-graph access is the requirement — §7.1 asks about annotations,
  embedded files, JavaScript, launch actions, incremental updates: all object-level, not rendering.
- **Cost**: the reference implementations are re-expressed, not reused. Slower to first output.

### Swift

- **POSIX reach**: complete, and the most direct route to §11.1 — Quick Action, "Open with",
  notarization, and an accessible SwiftUI surface are native rather than bridged.
- **Type-level enforcement**: good (non-optional types, `~Copyable` for a path that cannot be
  duplicated), short of Rust's.
- **Embedding**: excellent for the desktop, awkward for a CLI and MCP server that must run where
  Swift's toolchain is not assumed.
- **PDF parsers**: PDFKit is present and free, and it is a *rendering-oriented* API. Object-level
  access to incremental updates and malformed xref tables — §7.1's twelfth item — is where it stops
  answering. That is the item most likely to need a second parser anyway.
- **Cost**: cheapest path to a shippable macOS app; most expensive path to three interfaces sharing
  one core.

### Node / TypeScript (continuing what `tools/` already are)

- **POSIX reach**: `node:fs` has `open`, `link`, `rename`, `fsync`. It does **not** expose `openat`
  or `O_NOFOLLOW`, so handle-relative creation needs a native addon — which reintroduces a
  compiled component without the benefits of choosing one.
- **Type-level enforcement**: TypeScript brands are structural, erased at runtime, and exactly as
  forgeable as the WeakSet trick already in use. E1's AC would stay behavioural.
- **Embedding**: the desktop app becomes Electron or a bridge; §11.1's "native-feeling" and §22's
  notarization both get harder, not impossible.
- **PDF parsers**: `pdf-lib` (writes well, reads shallowly), `pdfjs-dist` (renders well, object model
  is internal), `mupdf.js` (WASM, complete, heavier).
- **Cost**: the lowest — the reference implementations *become* the product. That is also the risk:
  they were written to be read, with stubs for a filesystem, and their honesty depends on being
  explicitly not the runtime.

## Decision

**Rust for the core, Swift for the desktop shell, and `lopdf` (or MuPDF bindings) for PDF.**

Accepted as recommended. What follows is the argument as it was put, kept rather than rewritten so
that a later reader can judge the reasoning and not only the outcome.

The deciding argument is not performance and not taste. It is that **three of this repository's
safety claims are currently held by conventions that a type system would hold instead**:

| claim | how it is held today | under Rust |
|---|---|---|
| a path cannot reach the filesystem without passing the gate | `WeakSet` membership + `Object.freeze` | a type with a private constructor |
| `partial` is not `no_findings` | 2240 tested combinations | an enum the consumer must match exhaustively |
| a record's bytes are the bytes that were hashed | a copy on the way in, and a `WeakMap` off the record | ownership |

Each of those has already failed once in this repository and been fixed — the symbol-property brand
that object spread copied, the status table before its cases were named, the record whose `Buffer`
could be written through. They were caught by review and by mutation testing. A type system catches
that class before it is written.

The second argument is the two open POSIX capabilities. They are not exotic; they are the difference
between a gate that is safe and a gate that is safe *unless a directory is swapped at the wrong
microsecond*, and between §17.5 holding for crashes and holding for power loss. Node cannot reach
them without a native addon, which is the cost of Rust without the benefit.

## What this costs, honestly

- Everything in `tools/` is re-expressed, not ported. About 5,000 lines of reference implementation
  and vectors. The **rules**, which are data, carry over untouched — that was the point of putting
  them in JSON.
- Two languages in one repository, and a boundary between them that has to be maintained.
- Slower to a first working PDF check than continuing in Node.

## What stays true either way

The schemas, the rule tables, the fixtures, and the §20.2 boundary claims are language-agnostic and
do not move. The CI guard job's mutations are expressed against files, not against a language, and
most survive a port with their anchors rewritten.

## Not decided here

| Question | Owner |
|---|---|
| Whether the desktop shell embeds the core as a static library or talks to it over a local socket | #10 — it is a shell decision, and §14's diagram allows either |
| Which PDF parser specifically, once the language is settled — `lopdf` against MuPDF bindings, measured on the §7.1 items | #4 — it needs the fixtures E3.2 will build |
| Whether the MCP server is a separate binary or a mode of the CLI | #11 — both satisfy §14.1 as long as neither reimplements detection |
| Whether `tools/` is deleted after the port or kept as an executable second opinion | #4 — the port happens there, and what the reference implementations are *for* is answered by whether the port still needs them |
