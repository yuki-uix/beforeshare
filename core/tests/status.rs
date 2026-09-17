//! The status decision table, on the combinations no fixture produces.
//!
//! The order of its branches is the table in
//! `docs/contracts/status-and-exit-codes.md`, and the claim that matters most -
//! a blocking finding outranks incomplete coverage - had no case at all: no
//! fixture carries both, so reversing the two branches changed nothing.
use beforeshare_core::result::decide_status;
use serde_json::{json, Value};

fn finding(severity: &str, certainty: &str) -> Value {
    json!({ "category": "embedded_file", "severity": severity, "certainty": certainty })
}

#[test]
fn a_blocking_finding_outranks_incomplete_coverage() {
    let blocking = vec![finding("critical", "deterministic")];
    let gaps = vec!["ocr.visible_text".to_string()];
    let (status, reason) = decide_status(3, &gaps, &blocking, "application/pdf");
    assert_eq!(
        status, "blocking_findings",
        "incompleteness does not make a critical deterministic finding less true: {reason}"
    );
}

#[test]
fn incomplete_coverage_outranks_ordinary_findings() {
    let ordinary = vec![finding("high", "deterministic")];
    let gaps = vec!["ocr.visible_text".to_string()];
    let (status, _) = decide_status(3, &gaps, &ordinary, "application/pdf");
    assert_eq!(
        status, "partial",
        "partial is the only value that says this list is not exhaustive"
    );
}

/// §7.3 forbids presenting an ambiguous category as fact, and §17.1 requires no
/// clean control to be given a blocking deterministic finding. A probabilistic
/// critical finding is still shown and still severe - it just does not let the
/// product assert, as fact, that sharing must stop.
#[test]
fn a_probabilistic_critical_finding_does_not_block() {
    let probabilistic = vec![finding("critical", "probabilistic")];
    let (status, _) = decide_status(3, &[], &probabilistic, "application/pdf");
    assert_eq!(status, "review_required");
}

#[test]
fn nothing_completed_is_a_failure_not_a_clean_document() {
    let (status, reason) = decide_status(0, &[], &[], "application/pdf");
    assert_eq!(status, "failed");
    assert!(reason.contains("describes nothing"), "{reason}");
}

/// Checked before the zero-detector case: an out-of-scope file naturally has no
/// completed detectors, and calling that `failed` would blame the run for a
/// property of the input.
#[test]
fn an_unsupported_media_type_is_not_a_failed_run() {
    let (status, _) = decide_status(0, &[], &[], "image/tiff");
    assert_eq!(status, "unsupported");
}

#[test]
fn complete_coverage_with_nothing_found_is_the_only_clean_state() {
    let (status, _) = decide_status(7, &[], &[], "application/pdf");
    assert_eq!(status, "no_findings");
    // And one gap is enough to take it away.
    let (status, _) = decide_status(7, &["pdf.text_layer".to_string()], &[], "application/pdf");
    assert_eq!(status, "partial");
}

/// The one policy that shows a value in full is for values a detector wrote.
///
/// A review found a whole JavaScript program in a result because nothing could
/// tell a sentence about the file from a value copied out of it. The core
/// refuses the second under that policy rather than printing it, and the
/// exceptions are the categories the table lists as shown in full, each with a
/// reason.
#[test]
fn a_documents_own_value_is_not_shown_under_the_unredacted_policy() {
    use beforeshare_core::pdf::{
        Coverage, Detected, Inspection, Location, Provenance, StructureDetail,
    };
    use beforeshare_core::result::{assemble, InputFacts};

    let detected = |provenance| Detected {
        category: "document_producer".to_string(),
        detector: "pdf.metadata".to_string(),
        location: Location::FileStructure {
            detail: StructureDetail::IncrementalUpdate,
            revision: None,
        },
        value: "something the document said".to_string(),
        hides_a_removal: false,
        provenance,
    };
    let facts = InputFacts {
        path: "/tmp/x.pdf".into(),
        media_type: "application/pdf".into(),
        sha256: "0".repeat(64),
        size_bytes: 1,
    };
    let inspection = |d: Detected| Inspection {
        detected: vec![d],
        coverage: Coverage::default(),
        unreadable: None,
        has_images: false,
    };

    // document_producer is one of the listed exceptions, so it is allowed.
    assert!(
        assemble(
            &inspection(detected(Provenance::Document)),
            &facts,
            "01J0000000000000000000001",
            "2026-01-01T00:00:00Z",
            0
        )
        .is_ok(),
        "a category the table lists as shown in full was refused"
    );

    // The same value under a category that is not listed is refused.
    let mut unlisted = detected(Provenance::Document);
    unlisted.category = "encryption_state".to_string();
    unlisted.detector = "pdf.structure".to_string();
    let refused = assemble(
        &inspection(unlisted),
        &facts,
        "01J0000000000000000000002",
        "2026-01-01T00:00:00Z",
        0,
    );
    assert!(
        refused.is_err(),
        "a value copied out of the document was shown in full under structural_label"
    );
}

/// A location names data too, and the same gate applies to it.
///
/// The evidence beside it was masked under the category's policy while the
/// field name went out in full: one exit through the gate, one around it.
#[test]
fn a_field_name_in_a_location_is_masked_like_the_value_beside_it() {
    use beforeshare_core::pdf::{Coverage, Detected, Inspection, Location, Provenance};
    use beforeshare_core::result::{assemble, InputFacts};

    let inspection = Inspection {
        detected: vec![Detected {
            category: "form_field_value".to_string(),
            detector: "pdf.form_fields".to_string(),
            location: Location::PdfFormField {
                field_name: "applicant_national_id".to_string(),
                page: None,
            },
            value: "QQ-123456-C".to_string(),
            hides_a_removal: false,
            provenance: Provenance::Document,
        }],
        coverage: Coverage::default(),
        unreadable: None,
        has_images: false,
    };
    let facts = InputFacts {
        path: "/tmp/x.pdf".into(),
        media_type: "application/pdf".into(),
        sha256: "0".repeat(64),
        size_bytes: 1,
    };
    let result = assemble(
        &inspection,
        &facts,
        "01J0000000000000000000003",
        "2026-01-01T00:00:00Z",
        0,
    )
    .expect("assembles");
    let text = serde_json::to_string(&result).expect("serialisable");
    assert!(
        !text.contains("applicant_national_id"),
        "the field name went out in full: {text}"
    );
}
