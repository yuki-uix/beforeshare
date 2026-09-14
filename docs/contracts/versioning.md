# Versioning and compatibility

Implementation: [`tools/versioning.mjs`](../../tools/versioning.mjs).
Changelog: [`schemas/v1/CHANGELOG.json`](../../schemas/v1/CHANGELOG.json).
Run `npm run test:contracts`.

## `schemaVersion` is `MAJOR.MINOR`

No patch component. A change too small to move MINOR is a change too small to be worth a version, and
a third number invites treating some contract changes as beneath notice.

## What counts as breaking

| Kind | Classification |
|---|---|
| a field removed or renamed | breaking |
| an optional field made required | breaking |
| an enum value removed | breaking |
| a constraint tightened (a new `maxLength`, a narrowed pattern) | breaking |
| a type changed | breaking |
| an optional field added | additive |
| **an enum value added** | additive |
| a description clarified with no behaviour change | editorial |

### Adding an enum value is additive, and still refuses old consumers

This is the pair of statements that needs stating together, because each is misleading alone.

§20.3 requires consumers to fail visibly on unknown enum values. So a consumer built for 1.0 **will**
reject a result carrying a category added in 1.1. That rejection is the intended behaviour: a
consumer that silently tolerated an unknown category would be deciding, on its own, that a disclosure
class it has never heard of is safe to ignore.

It is classified `additive` rather than `breaking` because the schema did not break — the consumer
contract below is what refuses it, deliberately and visibly. Calling it breaking would force a MAJOR
bump for every new detector category and make the major number meaningless.

## The consumer rule

```
canConsume(resultVersion, consumerVersion)
```

- majors must match
- the result's minor must be **less than or equal to** the consumer's

There is no forward compatibility. A newer result may contain enum values or required fields an older
consumer does not know, and §20.3 says it must fail visibly rather than guess.

## Version granularity in results

Every result carries `versions.core` and a per-detector list, not one aggregate build number.

Per-detector is the right grain because the question a version answers is *"would this build produce
this result again?"*. A single build number says no whenever anything changed anywhere; per-detector
versions say no only when something that actually contributed changed — and say **which**, which is
what makes a stored result re-runnable against just the detectors that moved.

## Staleness

`resultIsStale(result, current)` returns why a stored result may no longer be reused:

- `core` changed
- a recorded detector is at a different version, or no longer exists
- a detector that **applies to this media type** is absent from the result

The third rule is scoped by media type on purpose. An image detector missing from a PDF result is not
staleness — it is the detector not applying. Without that scoping every PDF result would be
permanently stale, and a check that always fires is one people learn to ignore.

§14.1 requires a changed input to invalidate an earlier approval. A changed detector deserves the same
treatment: the finding set it would produce today is not the one recorded. Reusing it silently is how
a fixed false negative stays fixed only in the new code.

## The changelog is machine-readable and checked against itself

§13.3 requires a machine-readable changelog alongside the machine-readable schema. Every entry is
classified, and `changelogViolations()` fails the build when a `breaking` change is recorded under an
unchanged MAJOR — the case where a contract breaks consumers while claiming it did not.

It also rejects a `breaking` entry in the **first** release, where there is nothing to break. That
case is not hypothetical tidiness: with one release and no predecessor, the comparison had nothing to
compare against and passed vacuously — which is the only state a new schema is ever in.

## Adding to a closed enum, end to end

1. Add the value to the enum.
2. For a `category`, add its row to `category-defaults.json`; for a `coverageSkipReason`, classify it
   in `status-inputs.json`. The build fails until you do.
3. For a `remediationAction`, decide its capability facts and whether any verifier can confirm it.
4. Bump MINOR.
5. Record it in `CHANGELOG.json` as `additive`.
