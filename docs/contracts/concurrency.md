# What two runs on one machine may do at once

§20.2 lists *concurrent requests for the same input and output* as a boundary that must be tested.
§14.1 allows bounded local threads or processes and rules out a distributed queue, so everything
here is one machine and one file.

Three contracts were waiting on this. The identity checks compared against a set of run identifiers
the **caller** supplied (#35), the sweep needed to know whether a temporary file's owner was still
alive (#38), and crash recovery needed to know which runs were in flight (#37). All three needed a
record that outlives the process that made it.

## The lock is never held across waiting for a person

§11.1 requires per-finding review, so a run stops and waits for someone to read it. A lock held
across that wait turns one open confirmation dialog into a machine-wide stall — and the person who
could clear it is looking at a different window.

So the lock covers **one registry change** and is released before the caller sees anything. Nothing
the caller supplies runs inside it.

What makes that safe is that the approval never needed a lock: a stale approval is refused **on
content**, by the input hash (#35). The vector for this is the shape of the whole design — a first
run stops at the approval point, a second run starts and finishes, and the first run's approval is
still refused if the input changed while the dialog was open.

A lock nobody released is reported rather than waited on. Waiting for ever would let one stuck
process stop the machine.

## An unreadable registry stops the run

Starting fresh on a parse failure would silently reissue every identifier the file held, which is
exactly the defect a durable registry exists to prevent. The file is left alone for someone to look
at.

## The registry is replaced in one step, not written in place

The lock keeps two writers apart. It does nothing about readers, who do not take it — so a registry
written in place has an interval in which the file is a truncated JSON document, and a reader
arriving then is told the registry is unreadable. That stops a run with nothing to do with the
write. Writing beside it and renaming leaves no such interval, and a vector reads at the worst
possible moment to prove it.

## Two runs on one input never contend, and that is the point

Each candidate destination carries its own temporary name, and the reservation is what separates two
runs — so by the time either publishes, there is nothing to arbitrate. The vector says exactly that,
because saying it tested contention would be claiming a case the scenario cannot reach: a publish
mutated to replace whatever it finds leaves it green.

Contention needs a name taken **between** the claim and the publish, by something this run does not
control. That has its own vector, and there the publish does arbitrate: the loser does not land on
the name it wanted, the winner keeps what it published, and the loser still gets a complete file of
its own. This is #40's *two processes must not both believe they succeeded*, and it fails when the
publish is made to replace.

## Arbitration

| | |
|---|---|
| two inspections of one input | allowed, concurrently — inspection does not write, and two readers need no arbitration |
| two sanitizes of one input | allowed, each to its own destination — the naming protocol settles the name and the input hash settles whether an approval still applies |
| two runs wanting one output name | exactly one wins, decided by the publish rather than by the registry: a link refuses an existing name atomically and the loser steps on |

The registry does not arbitrate the output name, because #36 already does it better — atomically, at
the moment it matters, rather than by a record someone has to consult.

## Liveness has one implementation

"Is that process still there" was already answered by the temporary-file rules, which had to decide
whether a file was an orphan. The registry reuses it rather than keeping a second copy in step, and
the suite asserts the module does not reimplement it. Two copies of a rule are two things that can
drift, and the duplicate refusal names would have drifted with them.

## Not decided here

| Question | Owner |
|---|---|
| When the registry is compacted, and whether finished runs are ever removed | #39 — an unbounded file is a resource bound |
| Whether a lock should be waited on with a timeout rather than refused outright | #39 — the wait is a budget, and budgets are its subject |
| What a resumed run may touch after a crash, beyond knowing it existed | #41 — the boundary suite is where the resumed cases get written |
| Whether the registry should record the output path as well as the input | #41 — nothing needs it yet, and a field nothing reads is a rule nobody enforces |
