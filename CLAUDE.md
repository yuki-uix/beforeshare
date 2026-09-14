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
```

Runs three suites: schema validation with negative cases and drift checks, masking rules, and the
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

## Two habits this repository has had to learn

**Verify the artifacts against their own stated rules, not just against the case study.** The
recurring defect here has not been misreading the requirements — it has been writing a rule and then
shipping an example, an implementation, or a guard that violates it. Ordering rules, masking policies,
length caps and a `cancelled` field's documented promise have each been broken by the same PR that
introduced them.

**A guard that cannot fail is worse than no guard.** It reports coverage that does not exist. Before
trusting a new check, break the thing it guards and confirm it goes red — and confirm it goes red for
the right reason. A check that accepts any failure as proof of working will accept a missing
dependency or a syntax error as proof too.

## Tooling

`package.json` and `tools/` exist to validate the contracts. This is build tooling only — the schemas
are language-agnostic JSON Schema, and the core language is still undecided. It belongs in its own
ADR, not in an incidental choice here.
