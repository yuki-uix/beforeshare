//! Separate from the small taxonomy fixtures: valid but unsupported structures
//! must produce visible gaps, with nearby controls that still complete.
use beforeshare_core::{identity, pdf, result};

#[test]
fn boundary_samples_never_claim_unsupported_content_was_checked() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/pdf/boundaries");
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("manifest.json")).unwrap()).unwrap();
    let fixtures = manifest["fixtures"].as_object().unwrap();
    assert!(fixtures.len() >= 16);
    for (name, expected) in fixtures {
        let bytes = std::fs::read(dir.join(name)).unwrap();
        assert_eq!(
            identity::sha256_hex(&bytes),
            expected["sha256"],
            "{name}: fixture drift"
        );
        let inspection = pdf::inspect(&bytes);
        assert!(
            inspection.unreadable.is_none(),
            "{name}: fixture must parse"
        );
        let facts = result::InputFacts {
            path: format!("/fixtures/{name}"),
            media_type: "application/pdf".into(),
            sha256: identity::sha256_hex(&bytes),
            size_bytes: bytes.len() as u64,
        };
        let value = result::assemble(
            &inspection,
            &facts,
            "01J00000000000000000000000",
            "2026-10-18T00:00:00Z",
            0,
        )
        .unwrap();
        assert_eq!(value["status"], expected["expectedStatus"], "{name}");
        assert_eq!(
            value["coverage"]["failed"].as_array().unwrap().len(),
            expected["expectedFailed"].as_array().unwrap().len(),
            "{name}"
        );
        for failed in expected["expectedFailed"].as_array().unwrap() {
            let detector = failed["detector"].as_str().unwrap();
            assert!(!inspection.coverage.completed.contains(detector), "{name}");
            assert_eq!(
                inspection.coverage.failed[detector].0.as_str(),
                failed["errorCode"],
                "{name}"
            );
            assert!(
                value["limitations"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|l| l["affectedDetectors"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|d| d == detector)),
                "{name}: unexplained gap"
            );
        }
        for category in expected["expectedCategories"].as_array().unwrap() {
            assert!(
                value["findings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|f| f["category"] == *category),
                "{name}: missing {category}"
            );
        }
    }
}
