# The §7.1 fixtures

§17.1 reports a **rate**: required high-severity fixtures detected, 100%. A rate has a denominator,
and a category with no fixture is missing from it — which reads as full coverage of a smaller
requirement.

So the twelve categories are read out of the case study, and each one needs two files.

## A positive and a control that resemble each other

A detector that fires on the positive and also on the control has found the document, not the
disclosure. §17.1 puts clean controls wrongly given a blocking deterministic finding at **0**, and a
control that shares no structure with its positive cannot test that — the detector would have to be
wrong about something it never sees.

So the pairs differ in as little as possible, and several are built specifically to catch a detector
keying on the wrong thing:

| | the positive | the control |
|---|---|---|
| annotations | one text annotation with an author and a comment | `/Annots []` — present but empty |
| JavaScript and launch actions | document JavaScript and a `/Launch` action | an `/OpenAction` too, but a benign `/GoTo` |
| external references | a link to an internal host name | a link to its own page |
| invisible text | text rendering mode 3 | **the same sentence**, mode 0 |
| form fields | a field name and a value | the same field name, no value |

The suite checks that a control is not its positive and that the two are built from the same
document — object counts differing by at most two — because a control nobody made resemble anything
is a control that tests nothing.

**Object roles, and it took three attempts to measure anything.** A byte ratio never fired — the
closest pair sat at 0.68 against a floor of 0.5. Object counts were no better: an unrelated
five-object document differs from a six-object positive by one, so it passed while sharing nothing.
What *the same document* means is the set of object roles — `/Type` values plus the structural keys —
and that is what is compared.

## Written as raw syntax, not produced by a library

A library's output carries that library's habits — object numbering, compression, a `/Producer`
string it adds unasked — and a fixture exists to isolate one thing. Raw syntax is also reviewable in
a diff, which a binary is not, and §16.2 wants the generation method recorded rather than a file
whose origin is "some tool".

Deterministic on purpose: no timestamps, no random object ids, no compression. A fixture whose bytes
change between runs cannot have a hash in its provenance, and §16.2 requires one.

## A fixture can be well-formed and still be about something else

Three defects, each of which left a file that opened, hashed, and carried complete provenance:

| | what it actually tested |
|---|---|
| `/Length 44` on 45 bytes of CSV | malformed streams, not embedded files — a parser truncates the data or reads the remainder as syntax |
| `/Prev` pointing at end-of-file | nothing: a parser following the chain lands on an object and never reaches the revision the fixture exists to expose |
| `/Resources` declared twice | whatever this parser happens to do with a duplicated key, which PDF leaves undefined |

All three are now computed rather than stated — the writer counts the bytes and returns the offset —
and all three have a check, because the next one will be written by hand too.

## Three questions, and the third is the one that fails quietly

1. **Is there a fixture for every category?** Read from §7.1, with a floor, so a category added to
   the case study arrives uncovered and a category removed does not pass silently.
2. **Is each file what it claims?** §16.2's nine fields per fixture, and the recorded hash checked
   against the file's actual hash — a fixture edited by hand becomes its own label, and the label it
   was given stops describing it.
3. **Do they open?** The cross-reference offsets here are computed by hand. A wrong one produces a
   file every real parser refuses, while the hashes stay self-consistent and the manifest stays
   complete — twenty-four files, twelve categories, full marks, and nothing that can be read.

The third has its own check, and it earns its place: a generator mutated to write every offset one
byte late still produced twenty-four files with matching hashes and complete provenance, and
**twenty-three of them failed only this check**.

## What the expectations are worth right now

Each fixture records the coverage, remediation and status a detector should produce. Nothing reads
them yet, so they are **claims rather than assertions** — and the acceptance criterion asked for
them as canonical inspection results, which they are not.

They cannot be yet. A canonical result names detectors and carries evidence, and the evidence shape
for each §7.1 category is #61's subject; writing one here would decide it by accident, in a file
nobody would think to look in.

What is checked is the least that can be: each value is one the result schema actually has. A status
of `revew_required` is otherwise a label nobody notices is wrong until a detector disagrees with it
for the wrong reason. The real comparison — expected result against produced result — belongs to
#63, which is where a detector first exists to disagree.

## What these fixtures are not

They are not §16.1's frozen evaluation set. That is ≥60 files with licences and provenance, and it
belongs to #12. These are the deliberately constructed security fixtures §16.1 explicitly allows,
which that set can take in and freeze.

They also carry no real data. §16.1 forbids it, and every value here is invented and obviously so.

## Not decided here

| Question | Owner |
|---|---|
| Expressing the expectations as canonical inspection results rather than as three fields | #61 — the evidence shape per category is its subject, and writing one here would decide it by accident |
| Whether those expectations match what a real detector produces | #63 — a fixture's expected result is a claim until a detector exists to disagree with it |
| Whether `image-only-page` and `encryption-state` really produce a skip rather than a finding | #63 — the expectation is recorded and unverified, which is the honest state of both |
| The same treatment for §20.1's format and parser boundaries — malformed xref, unsupported compression, wrong extension | #63 — they need the checker to say what "handled correctly" means |
| JPEG and PNG fixtures, which need their own generator | #5 — the mechanism here transfers, the file format does not |
| Whether these are absorbed into the frozen evaluation set or referenced from it | #12 — it owns what the frozen set contains |
