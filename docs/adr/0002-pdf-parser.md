# ADR 0002 — the PDF parser under the deterministic checker

Status: **accepted**

[ADR 0001](0001-core-language-and-pdf-parser.md) chose Rust for the core and left
the parser as `lopdf` **or** MuPDF bindings, to be settled by measurement on the
§7.1 fixtures rather than by argument. This is that measurement and what it
decided.

## The experiment

`experiments/run.sh` regenerates `experiments/results.tsv`. Both probes ask the
same question of the same 24 fixtures — *can the parser hand over the object
carrying the disclosure the fixture planted* — and then load the same six
deliberately broken files. Nothing is copied by hand.

The question is deliberately not "does it detect": there is no detector yet, and
a probe that reimplemented one would be measuring the probe. Two of the probe's
own questions had to be corrected before the data meant anything, and both
corrections looked exactly like parser defects until they were read:

- the first version searched only top-level object dictionaries, so `/URI` under
  `/A` and `/XObject` under `/Resources` read as "the parser cannot reach it";
- the first version asked "does the page content decode", and the positive and
  the control decode to the same 134 bytes — what separates them is an operand,
  `3 Tr` against `0 Tr`.

## What the fixtures showed

`lopdf` reaches all twelve planted objects and MuPDF reaches all twelve as well.
They differ only in which API answers the two that live in the content stream
rather than in an object:

| §7.1 item | lopdf | MuPDF |
|---|---|---|
| text not visually obvious (`3 Tr`) | the operator carries the operand | per-glyph flags: neither `FILLED` nor `STROKED` |
| text beneath an apparent redaction | operators give the text and the covering rectangle's geometry | not through the structured-text layer, which reports text and images and not the paths painted over them — but the raw content stream is reachable and carries both |

The last cell was first written as an assertion and is now measured: the probe
reads object 4's raw stream and finds the text and the rectangle in it. Saying
"MuPDF reaches eleven" would have let a capability difference do work that does
not exist, in an ADR whose whole position is that the choice is measured rather
than argued.

**So capability is a tie**, and the decision rests entirely on what follows.

## What the fixtures could not show

They are all well-formed by construction, so they cannot separate a robust
parser from a brittle one — and robustness is the only ground on which the
heavier candidate could win. Six broken files were added for that, and they
produced the finding that decided the rest:

| input | lopdf (lenient) | lopdf (`strict: true`) | MuPDF |
|---|---|---|---|
| every xref offset one byte out | **loaded, 0 objects** | refused: invalid indirect object at byte offset 16 | loaded, 7 objects |
| no xref table at all | refused: failed parsing cross reference table | refused: failed parsing cross reference table | loaded, 7 objects |
| a stream whose `/Length` lies | loaded, 3 objects | refused: couldn't parse input | loaded, 7 objects |
| a reference to a missing object | loaded, 6 objects | loaded, 6 objects | loaded, 7 objects |
| truncated halfway | refused: failed parsing cross reference table | refused: failed parsing cross reference table | refused: MuPDF error, code: 8, message: invalid key in dict |
| an array nested 2000 deep | loaded, 5 objects | refused: couldn't parse input | loaded, 7 objects |

Each refusal carries its reason, and the check compares the reason rather than
the word: a bare "refused" made three different failures - a cross-reference
table that will not parse, an object that will not, and a depth limit - look
like one outcome, and a parser changing which one it gives would not have been
noticed.

**`Ok` with zero objects is the dangerous row.** A checker that treats a
successful load as permission to report findings would report *no findings* for a
document it never read — a clean bill of health on an unread file, which §17.1
counts as a release blocker rather than a bug. MuPDF recovers the content
instead; `strict: true` turns it into a named refusal.

## What this evidence is not

Three limits, stated here rather than left for a reader to discover:

**The six broken files are invented, not collected.** Each breaks one named
thing, which is what makes the comparison legible, and none of them came from a
real document. A parser that recovers from these may still fail on the ways real
producers break files, and the reverse. This is the weakest part of the case and
it is the part the decision leans on hardest.

**One machine, one run.** The outcomes used are mechanical — a load succeeds or
does not, and yields a countable number of objects — which is the kind of result
a single run settles. The timings in `results.tsv` are not mechanical and no part
of this decision rests on them; the drift check ignores them for that reason.

**The two probes were not asked identically, and could not be.** Each parser was
asked through whatever API it offers, because lopdf has no structured-text layer
to ask and MuPDF's object model is not lopdf's. The asymmetry that remains runs
*toward* the candidate not chosen: when MuPDF's text layer could not answer the
covered-text item, the probe fell back to its raw stream, and lopdf was given no
second attempt because it needed none. A tie reached that way is a tie.

## Decision

**`lopdf`, loaded with `strict: true`.**

1. Capability is a tie — both reach all twelve — so nothing here argues for
   paying more.
2. Its one dangerous failure mode is fixable by configuration: strict converts
   the silent under-read into a refusal the checker can report as a failure.
   A parser that reports nothing and a parser that reports failure are different
   products, and this one can be either.
3. `lopdf` is MIT; `mupdf` and `mupdf-sys` are **AGPL-3.0**. E10 ships a local
   MCP server and E14 distributes a signed application, so the licence is a
   live constraint on the product rather than a formality.
4. `mupdf-sys` vendors 64 MB of C reached through FFI. This is a dependency
   risk, not a lint violation: `#![forbid(unsafe_code)]` constrains the crate it
   is written in and says nothing about dependencies, and `core` already depends
   on `rustix`, which carries `unsafe` in 148 files and compiles fine underneath
   it. The difference is scale and audit surface - a small, widely-read syscall
   wrapper against a vendored C rendering engine - not a rule being broken.

   That row first claimed adopting MuPDF would mean writing an exception to the
   lint. It would not, and the repository disproves it: the dependency that
   disproves it was already there.

Point 2 is measured. Points 3 and 4 are constraints, not measurements, and they
are recorded separately on purpose: a policy that settles a measurement is how a
comparison stops being one. With capability tied, this decision **is** largely
the licence and the dependency — and saying so is more useful than a capability
argument that the measurement does not support.

## What MuPDF is genuinely better at, and when to revisit

It recovered all seven objects from both broken-cross-reference files, where
lopdf strict refuses. On synthetic fixtures that trade a false clean bill for a
refusal, which is the safe direction. On real-world documents it may trade away
detections instead.

The trigger to revisit is therefore measurable, not a feeling: if §17.1's
detection rate on the frozen evaluation set (#55, E11) is limited by documents
lopdf strict refuses, that is the signal. Until such a number exists, adopting an
AGPL C dependency would be paying a certain cost for a hypothetical gain.

## Not decided here

| Question | Owner |
|---|---|
| The three provisional limits — expansion ratio, object-graph depth, wall-clock — now that `LoadOptions::max_decompressed_size` is the place one of them lives | #56 — it owns the real numbers, and this ADR only names where the knob is |
| Whether a refusal from strict loading reports as a failure code or as a skipped detector | #63 — it belongs with the checker that has to emit one, and §10.2 already lists the outcomes |
| Whether the evaluation set eventually contains documents lopdf strict refuses | #55 — the reference-machine numbers are where that would show up |
| Whether `experiments/` is kept as a reproducible record or removed once the choice is settled | #4 — E3 owns what evidence its tasks leave behind |
