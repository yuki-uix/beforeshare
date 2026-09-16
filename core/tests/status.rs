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
