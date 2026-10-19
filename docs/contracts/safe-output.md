# Rust independent-copy publication

`core/src/safe_output.rs` implements the output-publication slice of #62 and the
file/directory durability protocol requested by #53. It consumes an owned
`ProducedBytes` from stage binding and returns an opaque `PublishedOutput` only
after the durability barriers succeed. This module writes prepared bytes; format
repair, obtaining human approval, and independent removal verification remain
adapter responsibilities. CLI capabilities and schema version 1.1 are unchanged.

## Publication protocol

```mermaid
flowchart LR
  A[核对运行与输入] --> B[固定目标目录句柄]
  B --> C[独占创建私有 part 目录和文件]
  C --> D[写完整并同步文件]
  D --> E[核对输入与目录身份]
  E --> F[硬链接原子发布]
  F --> G[同步目标目录与设备]
  G --> H[核对输出身份并清理临时内容]
```

The seven E2 rule tables remain unchanged. Naming reads `output-rules.json` and
uses the existing last-dot rule, marker, sequence start and 1,000-attempt bound.
Explicit output has one candidate; automatic output advances when a candidate is
occupied. Neither mode truncates or replaces an existing destination. Explicit
paths still pass the input-identity check, including hard-link aliases.

A reservation is `<candidate>.part`, exclusively created as a `0700` directory
beside the destination. Its payload is `output.part`, exclusively created `0600`.
Both names carry the existing incomplete marker. The extra private directory keeps
an unrelated local user with access to the destination directory from replacing
the link source while the writer uses it. The final file links a new inode,
independent of the original, and retains `0600` permissions. A second run can use
the next reservation while the first is writing. An occupied explicit reservation
reports `temp_name_taken`; occupied explicit publication reports
`destination_exists`; exhausted automatic names report `no_free_name`.

The gate pins authorised roots at construction. The writer walks normal relative
directory components with `openat`, `O_DIRECTORY` and `O_NOFOLLOW`; create, link
and cleanup then use those descriptors. Replacing a parent or temporary-directory
name with a symlink cannot redirect publication into its target. Rechecking the
parent before linking prevents knowingly publishing to a renamed directory and
returning a stale success path. After link, both directory identity and the final
entry's device/inode are checked again. A changed final entry is reported rather
than deleted as a rollback. As with all pathname APIs, another process with the
same write authority can rename entries after the last check; this is not an
exclusion mechanism against a malicious process running as the same user.

## Durability and failures

The order is:

1. Write in chunks of at most 64 KiB, checking cancellation between chunks.
2. `fsync` the complete payload; on macOS also request `F_FULLFSYNC`.
3. Recheck the stage-bound original and selected directory, then `linkat` without
   replacement. Until this call succeeds, the destination does not exist.
4. `fsync` the destination directory; on macOS issue a further `F_FULLFSYNC` on
   the still-open payload to flush the device after directory metadata is synced.
5. Check output identity, remove the temporary payload/directory and sync cleanup.

Success means that the OS accepted the file and directory durability barriers,
including Apple's device-flush requests. Unsupported or failed barriers are errors;
there is no silent downgrade to an unsynced result. Under a filesystem and device
that honour those calls, the complete output and its directory entry are durable
before success is reported. This extends the reference implementation's
process-death-only protocol to an explicit power-loss durability contract. It does
not certify arbitrary storage hardware or simulate a physical power cut in tests.

Cancellation is honoured before reservation, after reservation, between write
chunks, before file sync, and before each link attempt. After a successful link,
finish durability instead of deleting the complete file on a late cancellation.
Blocking filesystem syscalls themselves are not interruptible by this token.

`Error::code()` uses existing canonical path/identity/output/failure names. Disk
space/quota errors are `disk_full`; access/read-only errors are
`permission_denied`; other I/O failures are `write_failed`. `phase()` identifies
the failing boundary. Before link, `published_path()` is absent. A directory-sync,
device-flush or post-link identity failure reports the intended published path:
a complete file was linked, but durability or its current identity cannot be
confirmed. Do not retry blindly or remove that name as a rollback. A concurrent
rename can also make the intended path cease to locate the original directory.

Cleanup preserves the primary error. `cleanup_complete()` separately reports
whether successful publication removed its temporary namespace and synced that
removal. Cleanup failure can retain marked debris and does not undo an already
durable output. Cleanup sync is best effort and has no final Apple device flush,
so a power loss can restore marked debris even after successful cleanup. The writer does not sweep other runs' files; inode checks avoid
removing a visibly replaced temporary-directory entry. Crashes can leave marked
orphans for later owner-aware recovery.

## Evidence

Run `cargo test --workspace` and `npm run test:rust-output`. The npm bridge exposes
actual passing Rust test names to the existing §20.2 coverage collector; no copied
pass list can satisfy a boundary. The original JavaScript suites remain an
independent reference. `boundary-rules.json` adds Rust evidence without changing
the seven runtime rule tables.

Runtime tests cover independent inodes, permissions, every canonical action using
the one byte writer, collisions/exhaustion, concurrent publication, aliases,
parent/temp swaps, stale/foreign/released runs, mid-write cancellation, error
classification, sync order and pre/post-link failures. Running the writer for all
action names is a byte-writer check, not evidence that those format repairs exist.
A real child process exits without unwinding at all four canonical crash points:
original bytes remain unchanged, final names are absent or complete, and surviving
payloads retain the `.part` marker. Compile-fail cases reject raw unprepared bytes,
reusing consumed output, and forging a published receipt. CI adds eleven mutations
for the sync calls, link/rename distinction, permissions, cleanup, binding and
component walk; the Rust mutation total is 83.

## Measured sync cost

Reproduce with `cargo run -p beforeshare-core --example measure-safe-output` from
the repository. It writes synthetic data on that filesystem and removes all
sample files. [Recorded measurements](../measurements/safe-output-macos-aarch64.json)
use `basis: measured`, macOS/aarch64, debug profile, 20 samples per size:

| Output bytes | Publication median / p95 (ms) | Sync barriers median / p95 (ms) |
|---|---|---|
| 0 | 12.680 / 18.813 | 7.358 / 15.536 |
| 65,536 | 14.823 / 15.367 | 8.051 / 8.898 |
| 1,048,576 | 16.720 / 18.683 | 8.327 / 10.256 |

Publication timing includes existing-name collisions from earlier samples and
cleanup. Barrier timing includes file sync, Apple's flushes and publication's
directory sync, but excludes cleanup sync. These are local observations, not
worst-case limits or power-cut evidence. Persistent registry writes still need a
separate durability policy before that part of #53 can be claimed complete.

## Not decided here

| Question | Owner |
|---|---|
| Actual format repair and independent verification before enabling an action | #62 — the writer consumes bytes without claiming their contents were repaired |
| Durable registry and owner-aware orphan reclamation | #37 and #53 — process identity and registry persistence own recovery |
| Parent-component races in the legacy read/write primitives | #62 — the new descriptor walk currently protects the safe writer |
| Supported storage/filesystems and physical power-loss experiments | #53 — barrier success is conditional on storage honouring its contract |
| Cancellation latency reporting and integration into worker budgets | #39 — the token stops between bounded chunks but cannot interrupt kernel sync |
