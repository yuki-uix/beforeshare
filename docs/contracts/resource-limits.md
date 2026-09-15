# What a run may consume, and what an overrun is called

§17.1 puts *unsupported or failed checks mislabelled as completed* at **0 cases**, so the
interesting part of a limit is not the stopping. It is that an overrun becomes the same thing
wherever it happens, and never becomes a check that completed.

## Three names that already existed, and which applies when

`coverageSkipReason` had `input_too_large`; `detectorFailureCode` had `resource_limit_exceeded`
and `timeout`. Nobody had said which applied when, which is how one overrun comes to be reported as
a skip in one place and a failure in another.

| | coverage | decided |
|---|---|---|
| `input_too_large` | skipped | before any work starts |
| `resource_limit_exceeded` | failed | while working |
| `timeout` | failed | while working |

The discriminator is **when it was decided**, and it is enforced rather than described: an outcome
decided before work starts is a skip, and every other one is a failure. A skip is only honest when
nothing was attempted — reporting a half-done parse as skipped says the detector chose not to look.

`timeout` is separate from `resource_limit_exceeded` because the remedy differs. A bigger machine
does not fix a timeout the way it fixes a memory ceiling, and telling someone to free memory when
their file is merely slow sends them the wrong way.

## A bomb is small, so the ratio is what sees it

An absolute byte ceiling high enough to allow a large legitimate file lets a decompression bomb
straight through. What catches it is produced-per-consumed, checked as the bytes arrive.

The bomb in the vectors is a real one: a gzip stream this repository makes, expanded by node's own
decompressor, with the budget counting bytes as they arrive. 64 MB of zeros compresses to about
64 KB — near 1000:1 — and the run stops after **about 2%** of it has materialised. That is what the
acceptance criterion means by *refused before memory is exhausted*; simulated counters would have
proved the arithmetic and not the stopping.

A PDF object graph can contain a cycle, so depth is bounded rather than trusted to terminate — and
the counter is released on the way out, or a wide graph looks like a deep one. Both have vectors, and
the cyclic one uses an actual cycle: a test that walks a tree would never notice the bound was gone.

## An undeclared budget is not an unlimited one

…and neither is a budget of `NaN`. It is a number, `typeof` says so, and every comparison against it
is false — so it is no limit at all, declared. `Infinity` spells the same thing honestly, and a
negative budget refuses work that was inside any real one. A budget must be finite and positive.

Work asked to run without a budget is refused. Defaulting to unlimited makes the limit an opt-in,
and the case it exists for is the one where nobody remembered to opt in.

## Every default says where it came from

From a closed set: **measured** (a number this repository produces and can produce again),
**decided** (a judgement, stated as one), **provisional** (neither, with an owner who owes the
answer). A number with no basis gets defended later as though it had been measured.

| budget | basis |
|---|---|
| `memoryPerInputByte` | measured — a run holds ~2 bytes per byte of input |
| `inputBytes` | decided |
| `expansionRatio`, `graphDepth`, `wallClockMs` | provisional, owned by #41 |

### What measuring changed

The measurement was taken before the numbers were written, and it moved one of them.

```json
{
  "machine": "darwin/arm64 Apple M4 Pro",
  "host": "uix",
  "nodeVersion": "v23.7.0",
  "totalMemoryBytes": 25769803776,
  "sampleBytes": 33554432,
  "samples": 5,
  "hashBytesPerSecond": 3377891995,
  "readBytesPerSecond": 12189236237,
  "memory": [
    {
      "fileBytes": 8388608,
      "ratio": 2
    },
    {
      "fileBytes": 33554432,
      "ratio": 1.9997553825378418
    },
    {
      "fileBytes": 134217728,
      "ratio": 1.9999997019767761
    }
  ],
  "memorySpread": {
    "min": 1.9997553825378418,
    "max": 2
  },
  "inputBytesWithinQuarterOfTarget": 3306159210,
  "inputBytesWithinQuarterOfMemory": 3221225952
}
```

The input cap had been set as though size were bounded by time. It is not: on the machine that ran
this, time allowed about 3.2 GB and memory about 3.0 GB, so **neither is the binding constraint**.
The cap is therefore a decision — a desktop tool that takes a quarter of the machine for one file is
a bad neighbour even when it fits — and it says so rather than wearing a measurement it does not
have.

### The instrument had to be fixed before the number meant anything

The first version measured resident memory and reported 2.03, then 0.00, then 1.00 on repeated runs —
and took the largest sample, which hid the fault by choosing whichever run happened to be right.
`arrayBuffers` is the better instrument, but it is a **process-wide total**, so two things had to
change before it said anything true: every allocated buffer is kept alive for the whole run (release
one and the collector reclaims it partway through the next size, whose baseline already counted it),
and the measurement runs in a **child process** (the suite that calls it has just expanded a 64 MB
decompression bomb, and the baseline would otherwise be answering a question about the suite).

Each of those read as a finding on the way. A multiplier that falls as files get larger looks like a
discovery about large files; it was the measurement measuring itself. The suite now asserts the
multiplier does not vary with size — true by construction, one copy plus one more — so a reading
that varies fails as the instrument fault it is.

What the measurement did settle is the multiplier: the input is read whole and copied on the way
into the record (#36), so a run holds about **twice** the file before a detector sees anything. That
is the number the cap is reasoned against, and the one that changes if that copy ever goes.

These figures come from whatever machine ran them, which is **not** §17.4's documented reference Mac.
The method is committed so the figures can be taken again there.

## Not decided here

| Question | Owner |
|---|---|
| The real `expansionRatio`, `graphDepth` and `wallClockMs`, which need format fixtures | #41 |
| Cancellation latency and the §17.4 numbers on the reference Mac | #41 — the same machine settles all of them |
| Streaming the hash so a run holds one copy instead of two, which moves the measured multiplier | #41 — it changes #35's intake and #36's entry copy together |
| Whether the registry file is compacted, and when | #41 — an unbounded file is a bound nobody set |
| Whether a lock should be waited on with a timeout rather than refused | #41 — the wait is a budget and needs the same treatment |
| Durability: syncing the temporary file before the link and the directory after, and what it costs | #41 — measurable once there is a machine to measure on |
| A backup-exclusion attribute on the temporary file, and encryption at rest | #41 — both are costs, and neither has a number yet |
