# PR 70 follow-up

The default result must mask document-controlled metadata (case study §8.2).
Producer, timestamps and image device fields are not safe merely because a
typical producer puts a harmless value there. Their previous `shownInFull`
exceptions are removed. `structural_label` remains available for fixed facts
created by detectors. This changes the earlier evidence-policy decision;
the case study is unchanged.

Detector versions cover the final completed/failed/skipped sets, including
the synthetic OCR skip. The emitted-result suite compares both sets exactly.

Coordinate formatting rounds the original binary64 value. Multiplying by ten
first adds a rounding step and changes 1.15. Exactly representable half-tenths
(.25 and .75 fractional parts) need away-from-zero handling; other coordinate
values use Rust's direct fixed-precision formatting. Shared vectors exercise
both signs, exact ties, and values just below a decimal boundary.

The committed-results guard compares against HEAD and also checks untracked
outputs (including ignored files). An isolated Git repository test checks
untracked, staged, stale and identical output. Its cargo stub only simulates
deterministic regeneration; real parser output is checked by the existing
result-generation and schema suites.

## Not decided here

| Question | Owner |
|---|---|
| How does a user explicitly reveal a masked value locally? | E9 (#10) — desktop review and reveal controls |
