# Evidence masking rules

Every `evidence.displayValue` is produced by exactly one of the policies below, and the policy used
is recorded in `evidence.maskPolicy`. Recording it means a change in masking behaviour shows up as a
contract change rather than as a quiet difference in what users see.

The rules are applied to **code points**, not bytes, so that CJK text is masked by character rather
than by UTF-8 byte — masking `李建华` by bytes would produce mojibake and could still leak.

## Length cap

Values longer than **64 code points** are truncated to 64 before masking, and `truncated: true` is
set. The cap runs first so that neither the tail of a long value nor its exact length is disclosed.

Because truncation happens first, "the last code point" in the rules below means the last code point
*of the truncated value*, not of the original. **No ellipsis or other truncation marker is added** —
a marker would be one more character of structure to reason about, and `truncated: true` already
carries the fact.

## Policies

| `maskPolicy` | Applies to | Rule | Example in → out |
|---|---|---|---|
| `email_local_part` | `pii_email_address`, and metadata fields detected as email | First code point of the local part, then `***`, then `@` and the full domain | `yuki@example.com` → `y***@example.com` |
| `digits_keep_last_4` | `pii_phone_number`, `pii_government_or_account_id` | Every digit masked except the final four; non-digits preserved as separators | `+86 138 0013 8000` → `+** *** **** 8000` |
| `token_keep_edges` | `pii_credential_like` | First 2 and last 2 code points when length ≥ 8, `***` between; shorter values fall back to `fully_masked` | `sk-live-9fA2b7Qz` → `sk***Qz` |
| `text_keep_edges` | `pii_person_name`, `pii_postal_address`, `pii_user_defined_term`, annotation and comment text | First and last code point when length ≥ 4, `***` between; length < 4 falls back to `fully_masked` | `李建华` → fully masked; `李建华明` → `李***明` |
| `coordinate_coarsened` | `image_gps_coordinates`, `pii_geographic_coordinates` | Rounded to 1 decimal degree (~11 km) and marked redacted. Never shown at original precision, not even on reveal-adjacent surfaces | `31.2304, 121.4737` → `31.2, 121.5` |
| `fully_masked` | Any value too short for its policy to hide anything | Every code point replaced with `*`, count preserved up to the cap | `李明` → `**` |
| *(degraded)* | A value whose own policy would reveal too much | Falls back to `fully_masked`, and `maskPolicy` reports `fully_masked` — the result records what actually happened, not what was attempted | `李建华` under `text_keep_edges` → `***` |
| `structural_label` | Values that are not sensitive content but structural facts | Passed through unmasked with `redacted: false` | `AES-256`, `application/pdf` |

## Why short values fall back to full masking

A three-character name masked as "keep first and last" reveals two of three characters. Any policy
that would leave less than 2 code points hidden degrades to `fully_masked`. This is the one place
where the rules prefer showing the user less than they might want: the alternative is a mask that
looks like protection without being it.

## The cap applies to `structural_label` too

`structural_label` is unredacted, not unbounded. An oversized value arriving under
this policy is precisely the case where a detector has mislabelled content as
structure, so the 64-code-point cap still applies and `truncated` is still set.

## `structural_label` is the only unredacted policy

It exists because `encryption_state` and similar findings have no sensitive value to hide — the
finding *is* "this file is encrypted with AES-256". Every other policy sets `redacted: true`.
A reviewer should treat any new use of `structural_label` on a content-derived category as a
disclosure bug.

The schema enforces the pairing: `structural_label` requires `redacted: false`, and every other
policy requires `redacted: true`. The two fields cannot disagree.

## `fully_masked` preserves length; the other policies do not

`***` is a fixed marker: `李***明` hides an unknown number of code points. `fully_masked` instead
emits one `*` per code point, so it does disclose the exact length of a short value.

This is a deliberate asymmetry, but a narrow one. Length is only weak information when the value is
already too short for anything else to be shown, and preserving it keeps the masked form visually
proportional to what it replaced. It does mean a reviewer cannot tell from `李***明` alone whether
the source was 4 code points or 40 — which is the point.

## Determinism

Masking is a pure function of (value, policy). The same value masked twice produces the same string —
§17.5 requires deterministic output, and `displayValue` is output.

The rules on this page are executable: [`tools/masking.mjs`](../../tools/masking.mjs) implements them
and [`tools/test-masking.mjs`](../../tools/test-masking.mjs) runs every example printed above against
that implementation, plus the CJK, surrogate-pair, overlong, and short-value boundaries. Run them
with `npm run test:masking`. The tests call the implementation rather than recomputing the expected
output themselves — a test that recreates the rule stays green when the implementation drifts away
from it.

## Not decided here

| Question | Owner |
|---|---|
| How the user reveals a full value in the local UI, and what that path may touch | E9 (#10) — revealing is an interaction, and the rule here only says what a stored value may be |
| Keeping revealed values out of logs, telemetry and support bundles | E13 (#14) — same threat as the temporary file, a different exit |

The rule the schema enforces is narrower and absolute: **the full value has no representation in a
serialised result**, so no amount of mishandling downstream can turn a result into a disclosure.
