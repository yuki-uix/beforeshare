//! The masking cases, read from the file the JavaScript reference reads.
//!
//! Two implementations of a privacy guarantee are worth having only if they
//! answer identically; a port that satisfies the prose in masking.md while
//! disagreeing with the code looks correct from both sides.
use std::collections::BTreeSet;
use std::path::PathBuf;

use beforeshare_core::masking::{self, MAX_DISPLAY_CODE_POINTS};

fn vectors() -> serde_json::Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("the repository root")
        .join("schemas/v1/masking-vectors.json");
    serde_json::from_slice(&std::fs::read(path).expect("the vectors")).expect("valid JSON")
}

fn cases(v: &serde_json::Value, key: &str) -> Vec<serde_json::Value> {
    v[key]
        .as_array()
        .unwrap_or_else(|| panic!("{key} is a list"))
        .clone()
}

#[test]
fn every_documented_case_reproduces() {
    let v = vectors();
    let documented = cases(&v, "documented");
    assert!(
        documented.len() >= 7,
        "only {} documented cases",
        documented.len()
    );
    for case in documented {
        let value = case["value"].as_str().expect("a value");
        let policy = case["policy"].as_str().expect("a policy");
        let expected = case["displayValue"]
            .as_str()
            .expect("an expected display value");
        let expected_policy = case["resultPolicy"].as_str().expect("an expected policy");
        let got = masking::mask(value, policy).expect("a known policy");
        assert_eq!(got.display_value, expected, "{policy} on {value:?}");
        assert_eq!(got.mask_policy, expected_policy, "{policy} on {value:?}");
    }
}

#[test]
fn a_value_too_short_for_its_policy_is_fully_masked() {
    let v = vectors();
    let degrades = cases(&v, "degrades");
    assert!(
        degrades.len() >= 5,
        "only {} degradation cases",
        degrades.len()
    );
    for case in degrades {
        let value = case["value"].as_str().expect("a value");
        let policy = case["policy"].as_str().expect("a policy");
        let why = case["why"].as_str().unwrap_or("");
        let got = masking::mask(value, policy).expect("a known policy");
        assert_eq!(
            got.mask_policy, "fully_masked",
            "{policy} on {value:?} ({why})"
        );
        assert!(
            got.display_value.chars().all(|c| c == '*') && !got.display_value.is_empty(),
            "{policy} on {value:?} degraded to {:?}",
            got.display_value
        );
    }
}

/// One code point longer than the cases above. Without this the minimum could
/// quietly be the minimum plus one and every degradation case would still pass.
#[test]
fn the_boundary_case_does_not_degrade() {
    let v = vectors();
    let boundaries = cases(&v, "boundaries");
    assert!(
        boundaries.len() >= 3,
        "only {} boundary cases",
        boundaries.len()
    );
    for case in boundaries {
        let value = case["value"].as_str().expect("a value");
        let policy = case["policy"].as_str().expect("a policy");
        let got = masking::mask(value, policy).expect("a known policy");
        assert_eq!(
            got.mask_policy, policy,
            "{policy} on {value:?} should not degrade"
        );
    }
}

/// The rule the whole contract rests on: no policy but `structural_label` may
/// leave fewer than two code points hidden.
#[test]
fn no_policy_leaves_fewer_than_two_code_points_hidden() {
    let v = vectors();
    let short: Vec<&str> = v["shortValues"]
        .as_array()
        .expect("short values")
        .iter()
        .map(|s| s.as_str().expect("a string"))
        .collect();
    let policies = [
        "email_local_part",
        "digits_keep_last_4",
        "token_keep_edges",
        "text_keep_edges",
        "coordinate_coarsened",
        "fully_masked",
    ];
    let mut checked = 0usize;
    for policy in policies {
        for value in &short {
            let got = masking::mask(value, policy).expect("a known policy");
            let fully =
                !got.display_value.is_empty() && got.display_value.chars().all(|c| c == '*');
            let shown = got.display_value.chars().filter(|c| *c != '*').count();
            let hidden = value.chars().count().saturating_sub(shown);
            assert!(
                fully || hidden >= 2,
                "{policy} on {value:?} showed {:?}, hiding {hidden}",
                got.display_value
            );
            checked += 1;
        }
    }
    assert!(checked >= 48, "only {checked} combinations were checked");
}

#[test]
fn the_cap_runs_before_masking() {
    let v = vectors();
    assert_eq!(
        v["displayCap"].as_u64().expect("a cap") as usize,
        MAX_DISPLAY_CODE_POINTS,
        "the vectors and this implementation disagree about the cap"
    );
    let long: String = "\u{5f20}".repeat(500);
    let got = masking::mask(&long, "text_keep_edges").expect("a known policy");
    assert!(got.truncated, "an overlong value was not marked truncated");
    assert!(
        got.display_value.chars().count() <= MAX_DISPLAY_CODE_POINTS,
        "the display cap was exceeded: {} code points",
        got.display_value.chars().count()
    );
    assert!(
        !got.display_value.contains("500"),
        "the display value leaked the real length"
    );

    // structural_label is unredacted, not unbounded.
    let structural = masking::mask(&long, "structural_label").expect("a known policy");
    assert!(structural.truncated);
    assert!(structural.display_value.chars().count() <= MAX_DISPLAY_CODE_POINTS);
}

/// Every category has a policy, and no personal-information category is shown
/// unredacted. The validator checks the table; this checks that the core reads
/// the same table and agrees about it.
#[test]
fn every_category_the_core_can_emit_has_a_policy() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("the repository root")
        .join("schemas/v1/category-defaults.json");
    let defaults: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path).expect("category defaults")).expect("JSON");
    let categories: BTreeSet<&str> = defaults["categories"]
        .as_object()
        .expect("categories")
        .keys()
        .map(String::as_str)
        .collect();
    assert!(
        categories.len() >= 39,
        "only {} categories",
        categories.len()
    );
    for category in &categories {
        let policy = masking::policy_for(category)
            .unwrap_or_else(|| panic!("{category} has no evidence policy"));
        if category.starts_with("pii_") {
            assert_ne!(
                policy, "structural_label",
                "{category} is personal information and would be shown unredacted"
            );
        }
    }
}

#[test]
fn an_unknown_policy_is_refused_rather_than_guessed() {
    assert!(masking::mask("anything", "keep_everything").is_err());
    assert!(masking::policy_for("not_a_category").is_none());
}
