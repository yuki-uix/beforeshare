# Rust stage binding

This is the file-identity part of #62. The rule table remains
[`identity-rules.json`](../../schemas/v1/identity-rules.json); the JavaScript reference
and its tests remain in place. Runtime vectors in `core/tests/stage_binding.rs` exercise
all seven rejection reasons. Compile-fail cases establish private construction,
immutable input bytes, confirmation before approval, and consumption of the transform permit.

## Ownership and order

`core/src/stage_binding.rs` implements this sequence:

```mermaid
flowchart LR
  A[Bounded intake and hash] --> B[Immutable IntakeRecord]
  B --> C[Reopen original pathname and compare hash]
  C --> D[ConfirmedInspection]
  D --> E[Approval with selected actions]
  E --> F[Recheck and consume SanitizeInput]
  F --> G[Recheck input and own ProducedBytes]
  G --> H[Check candidate output identity]
```

Only `Registry::intake` constructs the record. Its owned bytes are hashed before
an immutable slice is exposed. The caller cannot construct, deserialize, mutate,
or clone the tokens. The confirmation means that input identity was rechecked;
it does not establish that a detector ran or that its coverage was complete.

Approval accepts a nonempty list from the existing remediation-action enum. It
records the caller's selection, not evidence that a human made that selection.
Future adapters must obtain user approval and restrict offered actions to their
implemented, independently verifiable capabilities. This module enables no actions.

The registry checks stage order and token membership by the identity of the private
input allocation, so the same run ID and file bytes in a second registry do not
accept tokens from the first. Transform authorization returns freshly checked
owned bytes; callers transform those bytes rather than reopening the input path.
The permit is consumed when output bytes are recorded. Output preparation rechecks
the original input once more, owns the supplied output, and records its hash.
`check_verify_allowed` compares a candidate's input and output hashes against that
run. It is an identity check, not a removal verification verdict or a disk write.

## Resource and filesystem boundaries

Every intake and re-read uses the caller's gate and the original intake size limit,
which must be positive and no greater than the canonical input budget. A caller
selects a finite registry run capacity. Released IDs remain spent and count toward
that capacity. Failed intake does not consume an ID. Release invalidates all tokens
for the run. The registry and its retired IDs live only for that registry session;
there is no durable ledger across process restarts.

Rechecks resolve the original selected pathname again, rather than reusing an old
pinned handle. This detects an atomic replacement with different bytes and an
in-root symlink retargeted to a different canonical path even with equal bytes.
Growth beyond the intake limit fails the corresponding input-change check.
Identical bytes restored before a recheck are intentionally indistinguishable from
unchanged bytes. This is snapshot identity, not a history of changes or an inode
identity guarantee. The path gate's existing parent-directory race boundary remains.

## CLI and contract compatibility

The experimental read-only CLI obtains its bytes, size, canonical path and SHA-256
from the same record, and confirms that record after inspection. Its existing worker
deadline covers both hashing and rechecking. A changed or unreadable input at this
point exits with the existing processing-failure code 5, a diagnostic, and no JSON
result. Intake path refusal (2), input size refusal (4), stable-file JSON structure,
schema version 1.1, and the canonical rule tables are unchanged. Existing committed
result fixtures must remain byte-identical. No remediation, published output,
persistent approval or verification capability is added.

The final regression run also exposed an existing Darwin supervisor race: an exited
leader can briefly refuse group cleanup before both pipe closures are visible. The
supervisor now retries under the original deadline, accepting completion only after
group cleanup succeeds or both pipes reach EOF. A deterministic test injects the
first refusal while a descendant still holds the pipes; cleanup cannot be waived.

## Not decided here

| Question | Owner |
|---|---|
| Safe output creation, parent-directory race closure and atomic publication | #62 — remaining Rust runtime work |
| Fsync and crash recovery before reporting a published file | #53 and #37 — those issues own durability and recovery |
| Actual metadata removal and independent verification before enabling an action | #62 — this module only binds identity |
| Durable run identifiers and user-approval adapters | #37 and #62 — durable registry and runtime adapter work |
| Whether to keep JavaScript as an independent implementation after the full port | #62 — the full port owns the reference implementation decision |
