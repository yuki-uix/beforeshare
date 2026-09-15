# §20.2's safety boundaries, and whether anything covers them

Every other suite in this repository asserts something about its own subject. This one asserts that
the requirement is covered at all — so it cannot take anyone's word for it, mine included.

## The list is read, not copied

The twelve boundaries come out of `docs/product-case-study.md` at check time. A list transcribed
into a file here would be compared with my own transcription: add a boundary to §20.2 and nothing
would notice, which is the failure this exists to prevent.

The parse is required to find something. A regex that silently matches nothing would report perfect
coverage of an empty list, which is the same shape of lie one level up.

And there is a **floor**, carried in the rule table: §20.2 must still list at least as many
boundaries as it did when this was written. Without it, deleting a boundary *together with its
claim* passed quietly — `staleClaims` only sees a claim whose boundary is gone, never a pair that
left together. Measured: two boundaries removed, twelve became ten, suite green.

Adding a boundary must not fail and removing one must not pass, so it is a floor rather than a
count. Lowering it is how someone says out loud that a safety requirement was dropped — and the
floor has its own guard, because otherwise whoever drops a boundary drops the floor in the same
edit.

## Coverage means a check that ran

Not "a check exists with this name" — a name that appeared as `ok` in a suite that actually
executed. The boundary suite runs the others, collects the names of checks that passed, and matches
them against what each boundary claims.

A claim names the **suite as well as the check** — `test:path-gate:an output equal to the input is
refused`. Two suites can carry the same name (three of them have *every declared refusal is
triggered by a vector*), and a boundary claiming a bare name would be covered by whichever check
happened to share it. Qualifying them caught one claim of mine attributed to the wrong suite, which a
bare name accepted.

So a renamed or deleted check takes its boundary's cover with it. That is deliberate and it is not
free: a check name is now a small public contract. Naming a file and line instead would make a
rename cheap and a *moved* check invisible, which is the worse trade — but if renaming becomes a
burden, that is the thing to reconsider. It is not in the handoff table below, because nobody owes
it: a question with no owner does not belong in a table whose purpose is naming one. That is the only way this stays
true while the suites keep changing, and it is not theoretical: **the first run of this suite found
four claims naming checks that do not exist**, written from memory by the person who also wrote the
claims.

One of those four was worse than a typo. The check it named had never reached `main`: the commit
message of #49 described a contention vector and a rename that were lost during a recovery from a
non-fast-forward push, and the PR merged with the message describing work the diff did not contain.
Eleven green suites, a passing review and a green CI did not see it. This did.

It runs inside `npm test`, at the end, and costs about two seconds. Leaving it out of the chain
would have made the suite that catches merged defects the one nobody runs before pushing — which is
where the defect it found got in.

## Covered, or owed — never both, never neither

| | |
|---|---|
| ten boundaries | named checks that ran |
| `extracted content containing prompt injection` | owed by #11 — the exit is the MCP tool boundary, and E2 does not read document text at all |
| `log and error redaction` | owed by #14 — the exit is the log, and E2 writes none |

A claim that is both is ambiguous; a claim that is neither is a boundary quietly set aside. Both
fail. An owed boundary must name an issue **and** say why, and both handoffs are recorded as
comments on the receiving issues rather than only here.

## What this does not do

It proves each boundary has a check that ran and passed. It does not prove the check is a *good* one
— that is what the mutation cases in CI are for, one layer down. A boundary covered by a vacuous
check would pass here and fail there, which is the division of labour on purpose: this suite asks
whether anyone looked, and the mutations ask whether looking would have found anything.

## Not decided here

| Question | Owner |
|---|---|
| Whether §20.1's format and parser boundaries deserve the same treatment | #56 — they need a parser before a vector can exist, and the mechanism here transfers unchanged |
| Whether §17's numeric targets should be claimed the same way, each naming a measurement that ran | #55 — the reference machine has to exist first |
| Whether the two owed boundaries are covered once their issues close, which nothing here will notice | #11 / #14 — closing an issue does not update a claim, and this suite has no way to ask |
