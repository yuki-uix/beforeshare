# File identity and stage binding

Rules: [`schemas/v1/identity-rules.json`](../../schemas/v1/identity-rules.json).
Reference implementation: [`tools/file-identity.mjs`](../../tools/file-identity.mjs).
Run `npm run test:identity`.

§14.1 requires file hashes to bind inspection, remediation and verification, and a changed input to
invalidate an earlier approval. §17.3 puts a number on it: **zero** stale approvals accepted.

The path is not the binding. A path is what stays the same when the content changes, which is exactly
the case the rule exists for.

## Hashing before reading is structural, not a rule

`intake()` reads the file once, hashes that read, and only then creates the record. Bytes are
reachable only through a record, so there is no ordering for an adapter to get wrong — the same shape
as the path gate, where a string cannot reach the filesystem.

This is recorded in the rule table as a **structural guarantee, not a rejection reason**. The
distinction is not pedantic: a reason describes a check that can fire, and the vector-coverage check
caught this one because no vector could reach it. Listing it made the table claim an enforcement the
code does not perform. What a structural guarantee needs instead is a test that the structure still
holds — `intake performs exactly one read`, plus the record brand — and the mutation that adds a
second read fails it.

The bytes are captured at intake rather than handed back as a path for the same reason the path gate
returns a handle: handing back a path reopens, for identity, the window it closed for authorisation.

The content is held **off** the record, in a private map, and `bytesOf()` returns a copy.
`Object.freeze` is shallow: a Buffer left on the record could be written through in place, leaving
the hash describing bytes nobody could obtain any more. The vectors used strings, which are immutable,
so this was invisible until a review asked about Buffers — and a real read returns a Buffer.

## What the approval carries

An approval names the run, the **input hash**, and the actions it covers. It does not name the path.

A user reviewed findings about specific bytes. If the bytes change, the findings describe something
else and the approval was never given for this content — so `checkSanitizeAllowed` re-hashes the file
and refuses when it differs. §17.3's zero is about this case.

Approvals are branded like records: a hand-built object is refused, and a copy of a real one is a
different object.

## One hash cannot see a swap

A hash taken at the start cannot distinguish a stable file from one replaced halfway through — both
produce the same opening hash. §20.1 requires a test for files changing during inspection, which means
the change has to be detectable, so `confirmUnchanged()` re-reads at the end and compares.

**What it answers is "is this the same file as when we started", not "was it untouched throughout".**
A file changed and changed back hashes the same and passes. That limit has its own vector, so it is
stated rather than assumed; closing it needs the file held open for the whole inspection, which
depends on what the gate's handles can offer.

## What is refused

| Reason | |
|---|---|
| `unknown_run` | a run identifier this process did not issue — §20.2 lists stale run identifiers as a required safety test |
| `stage_out_of_order` | verify asked for a run whose sanitize recorded no output |
| `input_changed_since_inspection` | the approved bytes are not the current bytes |
| `input_replaced_during_inspection` | the file changed while it was being read |
| `output_not_from_this_run` | verification handed a file this run did not produce — confirming removals on the wrong file is worse than not confirming them |

Every reason is triggered by a vector, and seven mutations against the implementation — dropping the
hash comparison, dropping the run check, skipping the re-read, defeating either brand, adding a
second read, and dropping the output comparison — are each caught by the vector written for it.

## Not decided here

| Question | Owner |
|---|---|
| Where issued run identifiers live across processes, so a restart does not forget them | #37 — it is the same durability question as crash recovery |
| Whether a re-read at the end is enough, or the file must be held open for the whole inspection | #34 — the gate owns handles; this builds on whatever it can offer |
| Hashing cost on large files, and whether it can share a pass with the adapters | #39 — it belongs with the resource limits |
| Reading the whole file into memory, which this implementation does and a product build cannot | #39 — streaming the hash is the same decision as the size limits |
| Who owns the set of issued run identifiers: the checks compare against what the caller supplies, so a caller with a wrong set defeats them | #37 — the registry has to survive a restart to be worth anything |
