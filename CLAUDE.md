# BeforeShare — repository instructions

## Source of truth

[`docs/product-case-study.md`](docs/product-case-study.md) is the requirements document. It is not
implementation and is not edited to match code. When an implementation disagrees with it, change the
implementation or write a decision record in `docs/contracts/` — never edit the case study to close
the gap.

Its numbered subsections contain **countable lists** (§7.3 personal-information categories, §9.1
remediation actions, §9.2 side effects, §10.2 verification results, §12.2 exit codes). Count them
against the enums rather than assuming a previous count was right. This has been wrong once: §9.1
lists eight actions and the enum shipped seven, with every test green — the tests checked that the
enum was closed, not that its contents matched the clause.

## Before pushing

```bash
npm test
cargo test --manifest-path core/Cargo.toml
```

`npm test` runs three suites: schema validation with negative cases and drift checks, masking rules, and the
status/exit-code decision tables. CI runs the same thing plus a second job that breaks invariants on
purpose and asserts the suite goes red for the expected reason.

## Code review

**Every PR needs a manual trigger.** CodeRabbit is installed and configured
(`.coderabbit.yaml`), but automatic reviews require the repository to have at least 10 stars, and it
currently has none. After opening a PR, comment:

```
@coderabbitai full review
```

Use `full review` rather than `review`: the incremental mode skips commits it considers already seen,
which on a first trigger can silently do nothing. Once the repository passes 10 stars this step
becomes unnecessary.

## What the contracts guarantee, and how

Three data tables drive behaviour, and each has a drift check that fails the build when it and its
enum disagree. Adding an enum value therefore forces the corresponding decision:

| Table | Forces a decision about |
|---|---|
| `schemas/v1/category-defaults.json` | a new category's default certainty and severity |
| `schemas/v1/status-inputs.json` | whether a new skip reason reduces coverage |
| `schemas/v1/examples/*.json` | nothing is declared by hand that the rules can compute |

Example `status` fields are **computed, not declared**. That proves the examples and the rules agree;
it does not independently verify the rules. The independent check is the named cases in
`tools/test-status.mjs`, whose expected values are written by hand from the case study.

## Four habits this repository has had to learn

**Verify the artifacts against their own stated rules, not just against the case study.** The
recurring defect here has not been misreading the requirements — it has been writing a rule and then
shipping an example, an implementation, or a guard that violates it. Ordering rules, masking policies,
length caps and a `cancelled` field's documented promise have each been broken by the same PR that
introduced them.

**A guard that cannot fail is worse than no guard.** It reports coverage that does not exist. Before
trusting a new check, break the thing it guards and confirm it goes red — and confirm it goes red for
the right reason. A check that accepts any failure as proof of working will accept a missing
dependency or a syntax error as proof too.

This extends to the mutation itself. A mutation that matches more than one site can land on the wrong
one, run the whole suite, and report a false green — which happened here, on two identical lines
constructing the same rejection: the mutation hit the unreachable one, and the survivor read as a
missing vector rather than as dead code. `core/tools/apply-mutation.py` refuses any mutation that
does not match exactly one site. And run the suite with `--no-fail-fast`: cargo stops after the first
test binary fails, so a mutation that breaks a unit test leaves the integration test a guard names
unrun, and the guard then reports that the vector has stopped working.

**A review finding names a class of defect, not a location.** Before pushing a fix, look for the same
defect everywhere else it could be, and say what you searched. A finding fixed only where it was
reported comes back as a new finding on the next PR, and the rounds do not converge.

This is the same two-way check the safety-gate rule already asks for — *a new guard, are all the
existing paths covered?* — applied to bug fixes rather than to new code. It has paid twice:
`identity-rules.json` was reported as comparing a file with itself, and `path-rules.json` turned out
to carry the identical defect, unreported; a stub that answered every path with the same bytes made
every vector written against it read as coverage it did not have.

Fixes are also the least reviewed code in the repository: each one is new, and the next review round
is reading it for the first time. Several defects here were introduced by the fix for the previous
one — a scoping fix that added a SIGPIPE bug, a coverage fix that suppressed six checks, a registry
added to stop unregistered ids being claimed and then claimed five in the same PR. Batch the fixes
for a round, re-run the guards, and scan for siblings before pushing.

**Commit before mutating, and confirm with `git diff` rather than with memory.** Mutation testing
restores by discarding the working tree — the CI script with `git checkout --`, and by hand the same
way. Any edit made since the last commit goes with it. This has happened four times here; twice the
suite stayed green afterwards, because the vectors proving the lost fix were in the same files and
were lost with it. What disagreed was the prose: a commit message and a contract document described
a reordering that was not in the code, and prose is not run.

So: commit, then mutate, then restore from git. And after an edit that matters, look at `git diff`
or grep the file for what you believe you wrote. "I changed that" is not evidence, and a green suite
is not evidence either when the change and its test disappeared together.

The guard script now refuses to start on a dirty tree, which covers the script and not the habit.

## Tooling

`package.json` and `tools/` validate the contracts and hold the reference implementations of the
product rules. The schemas stay language-agnostic JSON Schema.

`core/` is the product runtime, in Rust — decided in [ADR 0001](docs/adr/0001-core-language-and-pdf-parser.md)
and not by an incidental choice in the tooling. It reads the same rule tables with `include_str!`
rather than copying them, and its job is to hold by construction what the reference implementations
hold by convention: see [core-path-gate.md](docs/contracts/core-path-gate.md) for what that bought
and what it did not.
