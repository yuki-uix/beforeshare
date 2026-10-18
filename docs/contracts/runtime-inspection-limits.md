# CLI runtime limits and PDF inspection boundaries

This implements the existing input and wall-clock budgets from
`schemas/v1/limit-rules.json`. It does not change the product case study.

## File intake

The default input cap is currently 268435456 bytes (256 MiB). `core::limits`
reads that value from the canonical table; the CLI may lower it using
`--max-input-bytes N`, but cannot increase it. Limits must be positive integers,
may be supplied only once, and apply only to `inspect`.

The path gate opens the authorised input once. `read_file_limited` checks that
same handle's metadata and refuses non-regular files and oversized files before
allocating their contents. It then reads at most limit + 1 bytes from the same
handle using positional reads. Duplicating a descriptor does not give it an
independent seek position; positional reads prevent concurrent readers from
changing each other's cursor. The extra byte detects growth after the metadata check. An input exactly
at the limit is accepted. Replacement of the pathname does not replace the
handle being inspected. This is a file-byte cap, not a total-memory limit.

## An interruptible deadline

The public CLI launches the same executable in a private worker mode, with no
stdin. The worker performs path resolution, bounded intake, hashing, parsing,
detection, result assembly and rendering. The parent starts its monotonic timer
before spawning it. The default is currently 30000 ms; `--timeout-ms N` can only
lower it. The 30-second default remains provisional, not a reference-Mac result.

The parent drains nonblocking stdout and stderr fairly, with no reader threads
to join. It retains at most the canonical `workerOutputBytes` budget (currently
16 MiB combined). A worker that exceeds it is stopped and reports
`resource_limit_exceeded`, with no partial output forwarded. The output cap is a
product decision, not a measured input-size capability.

The worker starts in a separate process group. On timeout, output refusal or I/O
failure, an ownership guard kills its group and reaps the worker. On normal
exit, the supervisor observes the exit without reaping (`waitid` with `NOWAIT`),
stops remaining group members, drains the pipes within the same limits and then
reaps the leader. Holding the leader until cleanup prevents its PID being reused
as an unrelated group. Nonblocking reads ensure an inherited pipe cannot trap a
reader thread after the deadline. A signaled worker's output is discarded.

The private worker entry point also starts its own deadline before intake.
Direct invocation cannot turn the time budget off, and a supervisor that dies
cannot leave an indefinitely running parser. Its internal timeout exit 124 is
mapped to public exit 5 and buffered output is discarded. The private entry
point is not a public CLI interface; if the supervisor is externally killed,
the worker may continue until its own deadline.

Scheduling, OS process creation, kill/reaping and final pipe cleanup add overhead;
this is an enforced work deadline, not a real-time return-time guarantee.
The supervisor stops CPU-bound parsers and blocked intake rather than abandoning
a thread that keeps running after the command returns.

| Outcome | stdout | stderr | Exit |
|---|---|---|---|
| Intake exceeds the cap | empty | `input_too_large` | 4 |
| Worker exceeds its deadline | empty | `timeout` | 5 |
| Worker output exceeds the capture budget | empty | `resource_limit_exceeded` | 5 |
| Worker cannot start or terminates by signal | empty | processing diagnosis | 5 |
| Valid PDF has an unsupported inspection surface | canonical result | normal diagnostics | 4, or 5 if no check completed |

The canonical inspection schema requires a hash of the complete inspected bytes.
Intake refusal or a killed worker may never compute it. The CLI therefore emits
no canonical result in these cases: it must not fabricate a hash, coverage, or a
`no_findings` status. This follows the existing CLI convention for file-read
failures. Consumers must check the exit code and accept empty stdout on errors.
A future structured intake-error envelope needs its own contract; it cannot be
an inspection result with invented input facts.

The synchronous low-level `pdf::inspect(&[u8])` API does not own a process or a
wall-clock watchdog. Future desktop and MCP adapters must provide the same
supervision (or reuse this process boundary) rather than claiming their core
calls are automatically interruptible. Existing decompression and graph-walk
budgets still apply inside the inspector.

## PDF boundary samples

`fixtures/pdf/generate-boundaries.mjs` deterministically generates the separate
`fixtures/pdf/boundaries/` corpus and its versioned manifest. Labels include
hashes, expected status, failed detectors/codes, and expected finding categories.
The synthetic values are invented. This corpus does not replace the frozen
cross-format evaluation set required by the product specification.

The corpus covers:

- XMP referenced by a catalogue, page, or image XObject, plus a null-metadata control;
- Form XObject text reached through direct, indirect, and inherited resources;
- missing XObjects and an image XObject control;
- rotated graphics, skewed text, and a supported translation/scaling control;
- a background rectangle versus a later cover, ordinary visible text, and hidden text.

XMP XML parsing and nested Form text interpretation are not implemented here.
They now fail their detector with `unsupported_feature`, as do valid rotations
and skews outside the current geometry model. The result names each failed check
in `coverage.failed` and a `pdf_check_incomplete` limitation, preserving completed
checks without claiming the unsupported surface was inspected. Unresolvable
XObjects fail with `parser_error`. Results with a critical finding can still be
`blocking_findings` while carrying failed coverage; otherwise a gap with other
completed checks is `partial`.

These two enum additions advance the emitted contract to 1.1. Consumers of 1.0
must visibly reject 1.1 according to `versioning.md`. PDF metadata and text-layer
detector versions advance to 1.1.0; all committed taxonomy results are regenerated.

## Verification

- Rust intake tests cover sparse oversized files, exact-size reads, growth while
  reading, and pathname replacement while retaining the authorised handle.
- Supervisor tests stop an actual child process and check it is killed and
  reaped, exercise descendants holding inherited pipes, and verify exact and
  exceeded combined output budgets. Both stdout and stderr exceed pipe-buffer
  sizes in the normal-draining control.
- Rust boundary tests inspect every committed sample, check hashes and exact
  failed coverage, and require limitations for every failed check.
- `tools/test-cli.mjs` regenerates boundary labels/bytes in memory, invokes the
  real CLI, validates its JSON, checks exact failed coverage and sensitive-value
  masking, and tests sparse input refusal, limit argument validation, a real
  CPU-heavy PDF timeout, the private entry point deadline, output expansion,
  empty stdout, and unchanged original bytes.
- Contract versions for Rust results, CLI version and capabilities come from the
  latest changelog release. Tests check that a 1.0 consumer refuses current 1.1
  output and that the current consumer accepts the historical 1.0 examples.
  Failure and limitation diagnostics are capped in Unicode code points using the
  schema's message limits, including after adding an error-code prefix.

Regenerate with `npm run fixtures:boundaries` and `npm run results:regenerate`.
Run `cargo test --workspace`, `cargo fmt --check`,
`cargo clippy --all-targets -- -D warnings`, and `npm test`.
The committed-result guard compares against HEAD, so intentional regenerated
baseline changes must be committed before that guard can pass on a working tree;
it can be verified against a disposable committed snapshot without committing
the user's changes.

## Not decided here

| Question | Owner |
|---|---|
| Full XMP parsing and recursive Form XObject text interpretation | #4 — deterministic PDF adapter follow-up |
| Measured wall-clock and decompression limits on the reference Mac | #56 — the provisional budget owner |
| Reusing the process supervisor in desktop and MCP adapters | #10 and #11 — the interfaces that must own their execution boundaries |
| A structured preflight-error envelope without an input hash | #24 — CLI result and exit-code contract follow-up |
