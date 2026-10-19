# Experimental PDF Info field removal

This is a restricted core adapter for #7, built on stage binding and the safe
writer. It is not a completed #7/#8 pipeline. It adds no product command,
capability declaration, schema version, or successful independent verification.
The existing CLI and committed inspection results remain unchanged.

## Selection and approval

```mermaid
flowchart LR
  A[已哈希的输入记录] --> B[检查支持范围并选择字段]
  B --> C[展示字段和本文件的重写副作用]
  C --> D[审批固化为不可修改的对象]
  D --> E[重新核对输入并清理选定字段]
  E --> F[安全写出独立副本]
  F --> G[重新读取实际输出并核对运行哈希]
  G --> H[共享解析器读回：仍无法独立验证]
```

`pdf_metadata::plan` consumes the original opaque `IntakeRecord`, a nonempty list
of distinct `Field` values, and an explicit output-byte ceiling. The eight keys
are Author, Creator, Producer, Title, Subject, Keywords, ModDate and CreationDate.
The keys must exist and resolve to PDF strings. Unknown keys and implicit wildcard
expansion cannot be expressed by the enum; clearing all eight requires an explicit
selection such as `Field::ALL`. Duplicate or missing targets are
refused rather than silently broadened or treated as no-ops.

`Plan` exposes the input snapshot, selected keys and rewrite warnings without
copying evidence values into diagnostics. `Plan::approve` confirms that input
identity is unchanged and issues an approval for this owned plan. Adapters must
obtain the human's choice before calling it; the function does not display a UI.
The approved keys/budget cannot be mutated, a generic action approval cannot be
substituted, and publication consumes the approval. Compile-fail probes cover
forging, mutating, bypassing and reusing this authority.

Every full rewrite may change file size, which the existing side-effect enum
includes under `alters_visual_rendering`. If planning finds pre-existing objects
unreachable from the trailer, it also discloses their removal and
`makes_future_editing_harder`. Those warnings are bound to the reviewed input;
changed bytes invalidate approval. The module does not claim visual preservation
from a matching writer/parser readback.

## Supported profile and transformation

The first implementation is deliberately narrow:

- Strictly parsed PDFs with a classic xref table and exactly one `%%EOF` marker.
  Xref streams, hybrid/incremental history, object streams and linearized files
  are refused, including reserved object types the writer omits. The raw marker check is conservative: even a marker embedded in
  another value can cause refusal rather than admitting an ambiguous profile.
- One indirect `/Info` reference directly naming an exclusively used dictionary.
  Direct dictionaries, chained Info aliases and another reference to that
  dictionary are refused; editing an alias could otherwise change an unapproved
  page/catalogue dictionary. Selected string values may themselves be indirect.
- Encryption, signature indicators (`/Type /Sig`, `/FT /Sig`, `/ByteRange`,
  `/Perms`) and non-null `/Metadata` entries anywhere in the parsed object graph
  are refused before approval. No signature invalidation or XMP editing is
  silently accepted.

The transformation reads the newly rechecked bytes carried by `SanitizeInput`,
removes only the selected Info keys, and removes the trailer's Info entry if that
dictionary becomes empty. It then rewrites the entire PDF instead of appending a
revision. Bounded reachability pruning prevents removed indirect strings and
pre-existing unreferenced objects from being serialized as dead objects.
Before publication, shared-parser smoke checks require a readable nonempty page
tree, no dangling references and absent selected keys. These checks remain part
of the writer, not independent verification. A value still referenced by an
unapproved field remains: removing Author is not
permission to erase Title or visible text that happens to contain the same value.
Tests explicitly cover this distinction.

The parser uses the existing input/expansion budgets. Iterative object/reference
walks enforce the existing graph-node/depth budgets, reject dangling/cyclic
selected references and guard the writer's maximum-object-ID overflow. The
output buffer refuses to exceed the plan's positive ceiling, which cannot exceed
the canonical input-byte budget. Parsing/serialization remain synchronous core
calls; before exposing a product mutation entry point, an adapter must run them
under the existing killable-worker deadline. Cancellation is checked around
rewriting and by the safe writer during publication, not inside the parser.

The writer preserves other logical Info fields and page objects in regression
fixtures; the tests compare page count, MediaBox and content bytes with the
original. Those are shared-parser regression checks, not an independent render,
text or preservation verdict. Publication inherits owner-only independent files,
no-replace linking and file/directory durability barriers from
[safe output](safe-output.md), including its post-link error and cleanup semantics.

## Verification refuses false success

`PublishedRemoval::verify` reopens the actual published file through the gate,
keeps the approved output-byte ceiling and checks bytes against the run's recorded input/output
hashes before examining metadata. A foreign/replaced output is an identity error.
A missing/unreadable file produces `unable_to_verify` with
`output_could_not_be_reopened`; parser/readback errors cannot yield success.

The only current reader is `pdf.metadata_shared_readback`, implemented using
lopdf just like the writer. If a selected key remains, shared readback can disprove
removal with `still_present`. If keys are absent, the answer is still
`unable_to_verify` / `no_independent_reader_for_this_action`.
It does not claim `verified_removed`, independent reader status, examined raw
objects/text/rendering, or preservation of visible content. In the no-independent
case, `surfacesChecked` is empty and the read path carries no surface, as the
canonical action-result schema requires.

`verification::Outcome` is a closed, serde-checked enum for all five canonical
outcomes. Only verified_removed and verified_transformed succeed; explicit
matching forces changes when a new variant is introduced. ActionResult fields and
constructors are private to the readback implementation, so this adapter exposes
no way for callers to relabel its shared reader as independent. The public result
is an action-result fragment, not the full verification envelope or a whole-run
success decision.

## Validation

Run `cargo test --workspace` and `npm run test:metadata`. The npm script collects
actual passing Rust metadata tests and validates an action result generated by a
real plan/approval/publication/readback against the existing `actionResult`
subschema. It also proves that changing that shared-reader result to
verified_removed fails schema validation. §20.2 boundary evidence now includes
this adapter's stale-input/cross-registry checks; the original JavaScript checks
remain in place. The seven runtime rule tables are unchanged.

Fixtures cover all eight keys, UTF-16 and escaped strings, indirect/shared values,
page/content preservation regressions, orphan cleanup warnings, malformed and
unsupported profiles, size/cancellation failures, stale approvals, output identity
and no false independent success. Five compile-fail cases establish approval
ownership and exhaustive outcome handling. Eleven new mutations target actual
field removal, pruning, aliases, signature/XMP gates, output budgets, identity,
per-file side effects and verification success rules; CI's Rust total is 94.

## Not decided here

| Question | Owner |
|---|---|
| Independent metadata/raw-object/text readers and render preservation | #8 — these are required before this action can report verified removal |
| XMP, incremental/object-stream PDFs, custom metadata keys and reviewed signature invalidation | #7 — the adapter currently refuses unsupported transformations |
| Finding IDs, action groups, persistent run lookup and CLI sanitize/verify commands | #72 — the product entry point is explicitly gated on #7/#8 |
| Worker deadline integration and measured repair latency/memory | #39 and #56 — parser/serialization calls still need the guarded product worker |
