# How §7.1 reaches the canonical result

The taxonomy, the location union and the severity defaults all existed already. What was missing is
the **mapping** between them — and a mapping is exactly the kind of thing that gets decided by
accident inside an implementation, one `case` at a time, by whoever wrote the detector.

Written down, it can be checked in both directions.

## Both directions, because each hides a different failure

| | what it would mean |
|---|---|
| a §7.1 item nothing maps | the detector invents a category, or drops the item silently — and §17.1 counts the second |
| a category no item reaches | the taxonomy carries a value nothing produces: a category that looks supported and is not |

Twelve items reach twenty-one of the document-structure categories, and the count is exact in both
directions. That is not a coincidence — the taxonomy was built from §7.1 — but it is worth checking
rather than assuming, because the next item added to either side will not be.

## One §7.1 item names three different vocabularies

> parser warnings, malformed objects, incremental updates, and unsupported features

An incremental update is a **finding** (`incremental_update`). A malformed object is a
**`detectorFailureCode`**. An unsupported feature is an **`unsupportedReason`**. Only the first
belongs in the mapping, and saying so is the point: the other two have their own exits, and reporting
them as findings would make a statement about content nobody looked at.

## Where a location cannot point, it says so

The location union has no free-form variant (§8.2): a location the format can express must be
expressible, and one it cannot must be **omitted** rather than approximated. Each mapping records how
its location points at the thing, because the union alone does not say which field carries the
answer:

- `pdf_metadata.field` names the `/Info` key — one finding per populated field, not one for the
  dictionary, because a user approving removal is approving each value they were shown;
- `pdf_action.trigger` says what runs it, since the same action object reached from `/OpenAction` and
  from an annotation's `/A` is a different risk;
- `pdf_text_layer.characterRange` for hidden text, because a rectangle cannot describe text that
  renders nowhere;
- `file_structure` for the signature, not `pdf_form_field` — a signature is *carried* by a form field
  but the finding is about the document's integrity.

`image-only pages through local OCR` maps to **no category at all**, and says why: it is not a
disclosure, it is a page this build cannot read. §17.1 puts unsupported checks mislabelled as
completed at 0, so it is coverage skipped. An item that yields nothing is a decision; the check
refuses one that yields nothing silently.

## Blocking, and who decided it

Blocking is critical **and** deterministic. Two categories already reach it because **E1** set them
to critical — `embedded_file` and `text_under_redaction` — and neither is listed as needing an
escalation, because listing them would imply they did.

`category-defaults.json` allows a detector to raise a severity "with a documented reason". This epic
uses that **once**: `incremental_update`, from medium, when a previous revision holds values the
current one removes — the case where a user reading the current document cannot see what they are
about to send.

**What it does not do is raise `document_javascript`.** The first draft here said "critical always",
which would have stopped a user sharing any document containing script — including the ones their own
tools add. E1 set it to `high` deliberately, and §7.2's concern is that a user cannot *judge* a
script, not that every script is disclosure. A new table quietly overruling a considered decision
from another epic, in a file that epic would not think to read, is the failure mode; so the ones
considered and left alone are named, and the suite checks they still do not block.

An escalation must name the default it overrides, the condition, and why. "The detector decided" is
not a reason to stop someone sharing a file.

## Both directions means both, including the one that leaves debris

Checking that every §7.1 item is mapped is one direction. Checking that every mapping still answers
to a §7.1 item is the other, and it was missing: **a reworded requirement leaves its old key
behind**, and that key's categories went on counting as reached. The new wording failed separately,
for being unmapped — so the run reported one problem while the one that mattered stayed silent, in
the direction this table exists to check.

Measured: rewording *embedded files* to *embedded files and attachments* left `embedded_file`
looking reached by a mapping nothing pointed at any more.

The boundary suite had already learned this and called it `staleClaims`. The lesson did not travel
with me.

## The fixtures and these rules answer to each other

#60 recorded an expected status per fixture before these rules existed. Four expected
`blocking_findings`; two are backed by E1's defaults, one by the single escalation here, and one —
`javascript-and-launch` — was not backed by anything. The fixture was wrong, and it is
`review_required` now.

Neither file could have found that alone.

## Not decided here

| Question | Owner |
|---|---|
| Whether a detector actually emits these categories from these locations | #63 — a mapping is a claim until something implements it |
| The evidence `displayValue` and mask policy per category, which §7.3's masking rules constrain | #63 — the mask is chosen from the value, and no value exists yet |
| Whether `pdf.structure` should be one detector or three, given it carries encryption, signatures and revisions | #63 — the registry takes either, and the split only matters once coverage is reported per detector |
| Whether an incremental update that hides nothing should be reported at all | #63 — the rule says raise when it hides a removal, and says nothing about the quiet case |
