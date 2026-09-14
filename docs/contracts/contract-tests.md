# Contract boundary tests

Suite: [`tools/test-contracts.mjs`](../../tools/test-contracts.mjs). Run `npm run test:contracts`.

§20.3 lists six boundaries every result must respect. This suite checks the rules; `npm run validate`
checks the committed artifacts. The overlap is intentional — an artifact can be correct while the rule
behind it has quietly stopped being enforced.

Fixtures here are built in memory. §20.3 is about the contract, and a contract test that needed a PDF
parser could not run until the parser existed — which is precisely when these rules are easiest to
break and hardest to notice.

| §20.3 requirement | How it is checked |
|---|---|
| every result validates against the committed schema | a hand-built minimal result is compiled against the real schema |
| unknown enum values fail visibly | four enums mutated in turn: status, category, skip reason, limitation code |
| missing coverage fails visibly | the whole object removed, and one array removed |
| `partial` cannot become `no_findings` | run through `computeStatus`, not compared to a string |
| the three interfaces produce equivalent results | see below |
| schema versions explicit, compatibility tested | four `canConsume` cases plus a malformed version |

## The interface equivalence problem

None of the three interfaces exists yet. The obvious move — write the comparison and mark it skipped —
is the thing this repository has learned not to do: **a permanently skipped test and a permanently true
assertion are the same object**. Both report coverage that does not exist, and both survive review
because the suite is green.

So [`schemas/v1/interface-registry.json`](../../schemas/v1/interface-registry.json) names all three
interfaces with a status. An entry that is `not_implemented` must say which issue it waits on and may
not name an adapter. An entry that is `implemented` must name an adapter module that really exports
`produceResult`, and the equivalence comparison runs against every implemented interface.

The consequence: **the comparison starts the moment an interface claims to exist.** Nobody has to
remember to remove a skip marker. Flipping `cli` to `implemented` without writing the adapter fails
the build today — which a CI mutation verifies rather than assumes: the guard job flips `cli` to
`implemented`, removes its `waitingOn`, and requires `npm run test:contracts` to fail with
`interface cli names an adapter`.

When zero interfaces are implemented the suite prints a `note` line saying so, rather than a passing
assertion. A note is honest about there being nothing to compare; an `ok` would not be.

**This does not mean §20.3's equivalence requirement is met.** Nothing here compares three interfaces,
because there are none. The obligation is recorded on #9, #10 and #11 — each must flip its registry
entry and supply an adapter — rather than being quietly absorbed by a registry that only checks its
own consistency.

## Coverage completeness

`npm run validate` additionally requires every committed example to account for **every detector
applicable to its media type** — in `completed`, `skipped` or `failed`. A detector that applies and
appears in none of them is a check nobody can tell ran, which reads to a consumer as though it did.

This check found a real defect when it was written: the inspection examples listed five detectors for
a PDF while the registry declared eight applicable, and nothing said what the other three did.

Fixing that surfaced a second hole. Four detectors were added to `partial.json` as skipped, and no
limitation named them — so six checks were suppressed and only two were explained. Every
coverage-reducing skip and every failure must now be named by some limitation. Benign skips are
exempt: requiring a limitation for "this PNG has no EXIF block" would bury the real ones in noise.
The converse is checked too, scoped by impact — a `coverage_incomplete` limitation may not name a
detector that completed, while an `evidence_degraded` one legitimately can.

## Not decided here

| Question | Owner |
|---|---|
| Whether the CLI produces the canonical result, and its adapter | #9 |
| The same for the desktop app | #10 |
| The same for the MCP server | #11 |
| Whether the three actually agree on one fixture set | #9 / #10 / #11 — the comparison runs as soon as two of them are registered |

Nothing here compares three interfaces, because none exists. The registry checks its own
consistency; it does not stand in for the §20.3 requirement.
