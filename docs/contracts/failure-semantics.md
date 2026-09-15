# Cancellation, crashes and write failures

§17.5 puts *interrupted remediation producing an apparently valid final output* at **0 cases**. §6.3
requires a partially written output to be deleted or clearly marked incomplete, §12.1 requires that
cancellation not leave a file that appears successfully sanitized, and §20.2 lists cancellation
during write, disk-full, crash during remediation and permissions failure as boundaries that must be
tested.

## The zero is structural, not a cleanup step

The destination is created by a **link**, atomically, and only once every byte is in the temporary
file. There is no interval during which a partial file wears the finished name — so no crash,
cancel, power cut or full disk can produce one. That matters because the alternative is a cleanup
routine, and a cleanup routine is something that has to run: the case it exists for is precisely the
case where the process stopped running.

What the code here adds is the rest of the obligation — naming the failure instead of swallowing it,
and not leaving debris that accumulates.

## Crashes happen where they happen; cancels are noticed where the run asks

Two different lists, and conflating them leaves one of them untested.

| | |
|---|---|
| **interruption points** | `after_reserve`, `during_write`, `after_write`, `after_publish` — where the process can die. The suite interrupts each one and asserts the invariants, and a point nothing reaches fails the coverage check |
| **cancellation checkpoints** | `after_reserve`, `after_write`, `during_publish` — where the run asks. The validator compares these with the literals passed to `stop()` in the publish, so a checkpoint deleted from the code cannot go on being declared |

There is deliberately no checkpoint after the publish. Past the link the file exists and is complete;
a cancel arriving then is answered by the finished file rather than by tearing it up. The user asked
to stop, not to lose what was already theirs.

## The invariants, checked at every point

1. the original is byte-identical;
2. the destination is absent or complete — never partial;
3. anything left behind carries the incomplete marker, and is never at a name the user was told to
   look at.

## A failure keeps its diagnosis

`ENOSPC`/`EDQUOT` → `disk_full`. `EACCES`/`EPERM`/`EROFS` → `permission_denied`. Telling someone to
free space when they need access sends them the wrong way, so these do not share a code.

Everything else is `write_failed` rather than a guess. A cause nobody established is worse than an
unclassified one — and both are better than a success, which is what §17.5 is counting.

A refusal at the publish is reported, not stepped over to the next candidate: the next name would be
a different file from the one the caller was told about.

## Cleanup is required here, even though §6.3 allows debris

§6.3 permits a partial output that is clearly marked incomplete, and the invariants above accept a
surviving `.part`. But #36 handed this issue the case where it accumulates: the reservation is a
name, and one left behind by every failed attempt makes that destination unreachable for good. So a
failed attempt releases its name, and the proof is that the next attempt gets it back rather than
being pushed onto the following candidate.

One place releases it, for every way out. Releasing it beside each throw missed the cancellations
entirely — those are raised outside the block that catches filesystem errors — so every cancelled
run consumed a destination name for good, which is the accumulation this section is about. That is
what acceptance found.

The cleanup never throws. A cleanup that replaces the diagnosis tells the caller the unlink failed
and never mentions the disk being full.

## A crash is not a thrown error

Modelling a crash as an exception is modelling something else. The throw unwinds through the
module's own cleanup, which runs — and a dead process runs nothing. A suite built that way asserts
its invariants against a tidied state no crash can produce.

So the stub snapshots the disk at the instant of death, and the invariants are checked against that
snapshot. One vector then asserts the crash really did leave partial bytes behind: without it, the
scenario could quietly become an orderly failure while still calling itself a crash.

## Latency is measured, not assumed

§17.4 reports cancellation latency, which is the distance between asking and stopping. A boolean the
caller reads records neither end of it.

A run that was never cancelled reports `null`. A run that was asked and never stopped also reports
`null`, not `0`: zero would make the least responsive build look like the fastest one.

## Not decided here

| Question | Owner |
|---|---|
| How long a `.part` from a genuinely dead process may live, and who sweeps it | #38 — the temporary file's lifetime is its subject |
| Whether a `.part` is readable by other local users while it exists | #38 — side channels, with the same file |
| What a run record must persist to resume after a crash rather than restart | #40 — it needs the concurrency story to say what a resumed run may touch |
| Measuring cancellation latency on the reference Mac, against §17.4's other numbers | #39 — it owns the measured budgets |
| Whether a publish whose `unlink` fails should retry, leaving a second hard link to the same bytes meanwhile | #38 — what the temporary name may hold is its call |
