# The temporary file: permissions, place, and end

§15 lists *another local user reading temporary artifacts* among the threats a written model must
cover, and asks for likelihood, impact, mitigation, residual risk and test coverage for each one.
§20.2 lists temporary-file cleanup as a boundary that must be tested. This records both, and one
thing the design gets wrong on purpose.

## The temporary file lives in the user's own directory, and that has a cost

`~/Documents/report (sanitized).pdf.part`, beside its destination.

Not a private cache, because the publish is a **link**, and a link only works within one filesystem.
A temporary directory on another volume would make the publish silently become a copy — and a
half-copied file wearing the destination's name is the one thing §12.1 says must never appear.
Atomicity is the stronger guarantee, so it wins.

This was put as a question rather than settled quietly, because #38's own scope note asked for a
location outside anything backed up, synchronised or indexed, and moving there would mean undoing
the publish protocol #36 landed. **Decided: atomicity wins, the location stays.** The note was mine
rather than the case study's, which asks for the threat model and the cleanup test.

What that costs is written down rather than left out: the user's directory is watched by Time
Machine, by cloud sync, and by Spotlight. A temporary file there can be copied off the machine or
read by an indexer during its life, and owner-only permissions do not stop a backup agent running as
that same user. The mitigation is that the file's life is bounded by the publish — one write and one
link, with nothing waiting on a person in between — and the residual risk is that a sync client can
copy a file that exists for milliseconds. This build sets no exclusion attribute.

## Owner-only, at creation

`0600`, passed to the create rather than applied after it. A file created readable and narrowed
afterwards is world-readable for the interval between, which is the whole of the window someone
waiting for it needs.

The mode is passed, not assumed. A stub that records whatever it was handed proves the call and not
the result, so the vectors also create a file on a real filesystem with the same mode and read the
mode back — the same lesson as `realpath`, whose documented contract no filesystem implemented.

## An orphan is proved, not guessed

An orphan is a temporary file whose run is gone. Deleting one that is still being written is worse
than leaving it: that run loses its work and may publish nothing, so a cleanup becomes the loss it
was meant to prevent.

**Age is not proof.** A large input can take longer to process than any age threshold worth setting.

So reclamation requires the host to say the owning process is gone, and the owner is recorded as
process identity *and start time* — process ids are recycled, and matching on the id alone either
keeps an orphan for ever or reclaims a live file, depending on which way the reuse falls. A host
that cannot answer gets no reclamation at all, and the sweep reports what it kept and why rather
than only what it removed: a sweep that lists successes reads as though it had considered
everything.

## The four exits, and which one cleanup cannot reach

The temporary file does not outlive the publish on success, on cancellation, or on a failed write.
Each is a separate vector, because "cleanup happens" tends to mean "cleanup happens on the path I
was thinking about".

The fourth is a crash, and **cleanup does not run there at all** — #37 established that a dead
process runs nothing, including its own `finally`. So the crash path's cleanup is the sweep, and
that is where these two contracts meet: a crash leaves an orphan, the sweep finds it by its marker,
and reclaims it once the owner is provably gone. Answering the crash case with the `finally` would
have been answering it with code the case is defined by not reaching.

## The sweep finds its own candidates

`findTemporaryFiles` lists the directory and filters by the marker. A sweep handed its list by the
caller protects whatever the caller remembered to include — the same shape as a run registry the
caller fills in, and the same failure. A host that cannot enumerate is refused rather than given a
list to trust.

Which of those are orphans still needs an owner for each, and this build cannot read an owner back
off a file. That part is owed by the run registry.

## What the temporary file holds

It holds the sanitized output, which is derived from the input and therefore not harmless. Declaring
that is not enforcing it, so what is asserted is the enforceable half: exactly the bytes handed to
the publish arrive there and nothing else, and the input's bytes exist in exactly one place — the
input. An implementation that staged a copy of the original would be visible.

## Threats, with all five answers

| Threat | Residual risk |
|---|---|
| another local user reads the temporary file | root and the user's own agents are not excluded, and a crash leaves the file until something reclaims it |
| a backup or indexer copies it | a sync client can copy a file that exists for milliseconds; no exclusion attribute is set |
| a sweep deletes one still being written | proving a process is gone depends on the host, and a host that cannot answer must refuse |

Each entry names a vector by its exact text, and the validator checks the name is found in the
suite. *Mitigated, tested* is the sentence that stops anyone looking again, so the sentence has to be
true.

## Not decided here

| Question | Owner |
|---|---|
| Who runs the sweep, and when — at startup, on a timer, or never | #40 — it owns the run registry the sweep would read |
| Whether the temporary file should carry a backup-exclusion attribute, and what that costs | #39 — it owns the measured budgets, and a per-file attribute is one |
| Whether the sanitized output should be encrypted at rest while temporary | #39 — the cost is measurable and the benefit is bounded by the file's short life |
| Sensitive values in logs and crash reports, which share this threat and have a different exit | #14 — E13 owns the logging surface |
| Durability: syncing the temporary file before the link and the directory after | #39 — carried over from #37 |
