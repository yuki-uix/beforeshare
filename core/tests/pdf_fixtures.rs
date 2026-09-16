//! The §7.1 detection rate, measured against the fixtures that define it.
//!
//! §17.1 makes a missed detection a release blocker rather than a bug, so the
//! numbers here are the ones that decide whether the checker may ship: every
//! must-detect fixture detected, every clean control silent.
//!
//! Nothing links a fixture to a §7.1 item by hand. The manifest's
//! `labelDefinition` opens with the item's own sentence, and that sentence is a
//! key in `pdf-detection-rules.json` - so a reworded item breaks the link
//! loudly instead of quietly detaching a fixture from the rule it tests.
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use beforeshare_core::pdf::{self, Inspection};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("the repository root")
        .to_path_buf()
}

fn manifest() -> serde_json::Value {
    let path = repo_root().join("fixtures/pdf/manifest.json");
    serde_json::from_slice(&std::fs::read(path).expect("the fixture manifest")).expect("valid JSON")
}

fn detection_rules() -> serde_json::Value {
    let path = repo_root().join("schemas/v1/pdf-detection-rules.json");
    serde_json::from_slice(&std::fs::read(path).expect("the detection rules")).expect("valid JSON")
}

/// The §7.1 sentence a fixture is about, taken from its own label definition.
fn item_of(label_definition: &str) -> String {
    label_definition
        .trim_start_matches("\u{a7}7.1 \u{2014} ")
        .split(". carries")
        .next()
        .and_then(|s| s.split(". resembles").next())
        .expect("a label definition names its item")
        .to_string()
}

struct Fixture {
    name: String,
    positive: bool,
    item: String,
    expected_coverage: String,
    inspection: Inspection,
}

fn all_fixtures() -> Vec<Fixture> {
    let m = manifest();
    let entries = m["fixtures"].as_object().expect("fixtures");
    let mut out = Vec::new();
    for (name, meta) in entries {
        if name.starts_with('$') {
            continue;
        }
        let bytes = std::fs::read(repo_root().join("fixtures/pdf/files").join(name))
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        out.push(Fixture {
            name: name.clone(),
            positive: name.contains(".positive."),
            item: item_of(
                meta["labelDefinition"]
                    .as_str()
                    .expect("a label definition"),
            ),
            expected_coverage: meta["expectedCoverage"].as_str().unwrap_or("").to_string(),
            inspection: pdf::inspect(&bytes),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// The categories the rule table says that §7.1 item produces.
fn categories_for(item: &str, rules: &serde_json::Value) -> Vec<String> {
    rules["mapping"][item]["categories"]
        .as_array()
        .unwrap_or_else(|| panic!("no mapping for \u{a7}7.1 item: {item:?}"))
        .iter()
        .map(|c| c.as_str().expect("a category name").to_string())
        .collect()
}

#[test]
fn every_fixture_maps_to_an_item_the_rules_declare() {
    let rules = detection_rules();
    for f in all_fixtures() {
        assert!(
            rules["mapping"].get(&f.item).is_some(),
            "{}: its label names \u{a7}7.1 item {:?}, which the rule table does not declare",
            f.name,
            f.item
        );
    }
}

/// §17.1: every must-detect fixture is detected. A miss is a release blocker.
#[test]
fn every_must_detect_fixture_is_detected() {
    let rules = detection_rules();
    let mut missed: Vec<String> = Vec::new();
    let mut checked = 0usize;
    for f in all_fixtures().into_iter().filter(|f| f.positive) {
        let expected = categories_for(&f.item, &rules);
        if expected.is_empty() {
            // The mapping declares no category for this item on purpose - it is
            // the OCR one, which E5 owns. Not a miss, and not silently skipped
            // either: the assertion below keeps it honest.
            assert_eq!(
                f.expected_coverage, "skipped",
                "{}: the rules declare no category for its item, so the fixture must expect a skip",
                f.name
            );
            continue;
        }
        checked += 1;
        let found: BTreeSet<&str> = f
            .inspection
            .detected
            .iter()
            .map(|d| d.category.as_str())
            .collect();
        // Every category the item declares, not one of them. "One of" passed
        // for an item whose two halves are an external reference and a
        // local-file reference while only the first was ever produced - the
        // second had no sample and no detector, and the release-blocker claim
        // covered it on paper.
        let absent: Vec<&String> = expected
            .iter()
            .filter(|c| !found.contains(c.as_str()))
            .collect();
        if !absent.is_empty() {
            missed.push(format!(
                "{} declares {expected:?}, did not produce {absent:?}",
                f.name
            ));
        }
    }
    assert!(
        checked >= 11,
        "only {checked} must-detect fixtures were checked"
    );
    assert!(
        missed.is_empty(),
        "missed detections (\u{a7}17.1 release blockers):\n  {}",
        missed.join("\n  ")
    );
}

/// §17.1: a control is silent unless the manifest says why it is not.
///
/// "Controls produce nothing" was written here first as a rule of the suite,
/// and one fixture disagreed: both documents of the form-fields pair carry the
/// field name `applicant_national_id`, which §7.1 counts as a disclosure on its
/// own, and only the value is blocking. The manifest is the authority on what
/// each fixture expects, so it is read rather than assumed - and a control that
/// is not silent must still separate something from its positive, or the pair
/// tests nothing.
#[test]
fn a_control_is_silent_unless_its_manifest_says_why_not() {
    let rules = detection_rules();
    let m = manifest();
    let fixtures = all_fixtures();
    let mut wrong: Vec<String> = Vec::new();
    let mut silent_checked = 0usize;
    let mut excepted_checked = 0usize;

    for f in fixtures.iter().filter(|f| !f.positive) {
        let expected = categories_for(&f.item, &rules);
        if expected.is_empty() {
            continue;
        }
        let entry = &m["fixtures"][&f.name];
        let expects_silence = entry["expectedStatus"] == "no_findings";
        let found: BTreeSet<String> = f
            .inspection
            .detected
            .iter()
            .filter(|d| expected.iter().any(|e| e == &d.category))
            .map(|d| d.category.clone())
            .collect();

        if expects_silence {
            silent_checked += 1;
            if !found.is_empty() {
                let values: Vec<String> = f
                    .inspection
                    .detected
                    .iter()
                    .filter(|d| expected.iter().any(|e| e == &d.category))
                    .map(|d| format!("{}={:?}", d.category, d.value))
                    .collect();
                wrong.push(format!(
                    "{}: expects silence, produced {found:?} -> {values:?}",
                    f.name
                ));
            }
            continue;
        }

        excepted_checked += 1;
        let reason = entry["controlIsNotSilentBecause"].as_str().unwrap_or("");
        if reason.len() < 10 {
            wrong.push(format!("{}: is not silent and gives no reason", f.name));
        }
        // It declared it would not be silent, so silence is a broken promise.
        // The subset check below is satisfied by producing nothing at all.
        if found.is_empty() {
            wrong.push(format!(
                "{}: expects {} and produced nothing in {expected:?}",
                f.name,
                entry["expectedStatus"].as_str().unwrap_or("?")
            ));
        }
        // It must still separate something. A control that produces everything
        // its positive does is not a control.
        let positive_name = f.name.replace(".control.", ".positive.");
        let positive = fixtures
            .iter()
            .find(|p| p.name == positive_name)
            .unwrap_or_else(|| panic!("{} has no positive", f.name));
        let positive_found: BTreeSet<String> = positive
            .inspection
            .detected
            .iter()
            .filter(|d| expected.iter().any(|e| e == &d.category))
            .map(|d| d.category.clone())
            .collect();
        if !(found.len() < positive_found.len() && found.is_subset(&positive_found)) {
            wrong.push(format!(
                "{}: produced {found:?} against its positive's {positive_found:?}, so the pair separates nothing",
                f.name
            ));
        }
    }

    assert!(
        silent_checked >= 10,
        "only {silent_checked} silent controls were checked"
    );
    assert!(
        excepted_checked >= 1,
        "no control exercised the stated-exception path"
    );
    assert!(
        wrong.is_empty(),
        "controls disagreeing with their manifest:\n  {}",
        wrong.join("\n  ")
    );
}

/// Coverage is a claim, and an untrue one is what §17.1 counts. A detector that
/// did not run must say so; one that ran must not be listed as skipped.
#[test]
fn coverage_names_every_detector_exactly_once() {
    let declared: BTreeSet<&str> = pdf::declared_detectors();
    for f in all_fixtures() {
        let c = &f.inspection.coverage;
        let mut seen: BTreeMap<&str, usize> = BTreeMap::new();
        for name in c
            .completed
            .iter()
            .chain(c.skipped.keys())
            .chain(c.failed.keys())
        {
            *seen.entry(name.as_str()).or_default() += 1;
        }
        for name in &declared {
            assert_eq!(
                seen.get(name).copied().unwrap_or(0),
                1,
                "{}: {name} appears {} times in coverage, not once",
                f.name,
                seen.get(name).copied().unwrap_or(0)
            );
        }
        // And nothing else. Checking only that each declared detector appears
        // left a coverage report free to name a detector nobody declared,
        // which a consumer would have to interpret and could not.
        let reported: BTreeSet<&str> = seen.keys().copied().collect();
        assert_eq!(
            reported, declared,
            "{}: coverage names detectors the rule table does not declare, or omits some",
            f.name
        );
        // A reason the schema recognises, and a message a person can act on.
        // The reason used to be prose, which the result cannot carry: a
        // consumer decides whether a gap reduces coverage from the code, and
        // cannot do that from a sentence.
        for (name, (reason, message)) in &c.skipped {
            assert!(
                ["not_applicable_to_media_type", "blocked_by_encryption"]
                    .contains(&reason.as_str()),
                "{}: {name} skipped for {:?}, which the result schema does not allow",
                f.name,
                reason.as_str()
            );
            assert!(
                message.len() > 10,
                "{}: {name} skipped with no message",
                f.name
            );
        }
        for (name, (code, message)) in &c.failed {
            assert!(
                ["parser_error", "malformed_input", "internal_error"].contains(&code.as_str()),
                "{}: {name} failed with {:?}, which the result schema does not allow",
                f.name,
                code.as_str()
            );
            assert!(
                message.len() > 10,
                "{}: {name} failed with no message",
                f.name
            );
        }
    }
}

/// Every location a detector emits comes from the table, so a result cannot
/// carry a location kind nobody can interpret.
#[test]
fn every_emitted_location_kind_is_declared() {
    let rules = detection_rules();
    let known: BTreeSet<String> = rules["mapping"]
        .as_object()
        .expect("mapping")
        .values()
        .filter_map(|item| item["location"].as_str().map(str::to_string))
        .collect();
    // The two content-stream items share a location kind the mapping gives, and
    // the document-level ones use `pdf_document`; anything else is invented.
    // Per category, not merely "a kind somebody declares". A finding carrying a
    // kind that belongs to a different category is as uninterpretable as an
    // invented one, and the looser check accepted it.
    let kind_of: BTreeMap<String, String> = rules["mapping"]
        .as_object()
        .expect("mapping")
        .values()
        .filter_map(|item| {
            let kind = item["location"].as_str()?;
            Some(
                item["categories"]
                    .as_array()?
                    .iter()
                    .filter_map(|c| c.as_str().map(|c| (c.to_string(), kind.to_string())))
                    .collect::<Vec<_>>(),
            )
        })
        .flatten()
        .collect();
    assert!(
        known.len() >= 6,
        "only {} location kinds were read",
        known.len()
    );
    for f in all_fixtures() {
        for d in &f.inspection.detected {
            let expected = kind_of.get(&d.category).unwrap_or_else(|| {
                panic!(
                    "{}: {} emitted category {:?}, which no mapping declares",
                    f.name, d.detector, d.category
                )
            });
            assert_eq!(
                &d.location.kind, expected,
                "{}: {} put {} at {:?}, but the mapping says {expected:?}",
                f.name, d.detector, d.category, d.location.kind
            );
        }
    }
}

/// §7.1 asks for one finding per populated metadata field, not one for the
/// dictionary — a person approving removal approves each value they were shown,
/// and the fixture's own instruction says so.
///
/// Written because "one of the expected categories was found" let a detector
/// that reported a single field pass. The expected set is read out of the
/// fixture rather than listed here: the first version listed `ModDate`, which
/// this fixture does not carry, and a test that states the document's contents
/// from memory is testing the memory.
#[test]
fn metadata_is_reported_field_by_field() {
    let path = repo_root().join("fixtures/pdf/files/document-metadata.positive.pdf");
    let options = lopdf::LoadOptions {
        strict: true,
        ..Default::default()
    };
    let doc = lopdf::Document::load_with_options(&path, options).expect("the fixture parses");
    let info = doc
        .trailer
        .get(b"Info")
        .ok()
        .and_then(|r| doc.dereference(r).ok())
        .and_then(|(_, o)| o.as_dict().ok().cloned())
        .expect("the fixture carries an /Info dictionary");
    let present: BTreeSet<String> = info
        .iter()
        .map(|(k, _)| String::from_utf8_lossy(k).to_string())
        .collect();
    assert!(
        present.len() >= 7,
        "the fixture should carry seven fields, it has {}",
        present.len()
    );

    let f = all_fixtures()
        .into_iter()
        .find(|f| f.name == "document-metadata.positive.pdf")
        .expect("the metadata fixture");
    let reported: BTreeSet<String> = f
        .inspection
        .detected
        .iter()
        .filter(|d| d.detector == "pdf.metadata")
        .filter_map(|d| d.location.field.clone())
        .collect();

    let missing: Vec<&String> = present.difference(&reported).collect();
    assert!(
        missing.is_empty(),
        "the /Info dictionary carries these and the detector did not report them: {missing:?}"
    );
    let invented: Vec<&String> = reported.difference(&present).collect();
    assert!(
        invented.is_empty(),
        "reported fields the document does not have: {invented:?}"
    );
}

/// A document that cannot be read must not come back as one with no findings.
///
/// The malformed set from ADR 0002 is the only place this is reachable: every
/// §7.1 fixture parses, so a mutation removing the empty-parse guard survived
/// the whole suite while looking covered.
#[test]
fn an_unreadable_document_fails_every_detector_rather_than_completing_them() {
    let broken = repo_root().join("experiments/malformed");
    let mut checked = 0usize;
    for entry in std::fs::read_dir(&broken).expect("the malformed set") {
        let path = entry.expect("readable").path();
        if path.extension().and_then(|e| e.to_str()) != Some("pdf") {
            continue;
        }
        let bytes = std::fs::read(&path).expect("bytes");
        let inspection = pdf::inspect(&bytes);
        let name = path.file_name().unwrap().to_string_lossy().to_string();

        if inspection.unreadable.is_some() {
            checked += 1;
            assert!(
                inspection.detected.is_empty(),
                "{name}: reported findings from a document it could not read"
            );
            assert!(
                inspection.coverage.completed.is_empty(),
                "{name}: completed detectors on a document it could not read"
            );
            assert_eq!(
                inspection.coverage.failed.len(),
                pdf::declared_detectors().len(),
                "{name}: not every detector is recorded as failed"
            );
        } else {
            // It parsed. Then it must have been read: a checker that completes
            // every detector against nothing is the §17.1 shape this guards.
            assert!(
                !inspection.coverage.completed.is_empty(),
                "{name}: parsed, yet no detector completed"
            );
        }
    }
    assert!(
        checked >= 3,
        "only {checked} malformed inputs were actually refused"
    );
}

/// A detector that cannot apply says so, with a reason the result can carry.
///
/// The case here was a document with no pages, which was wrong twice over: a
/// document with no pages has no text because it has no pages, and reporting a
/// skip claimed a gap that does not exist. Encryption is the real one - the
/// content streams are there and cannot be read, so a detector that completed
/// would be claiming it looked.
#[test]
fn a_detector_that_cannot_apply_is_skipped_with_a_reason() {
    let encrypted =
        std::fs::read(repo_root().join("fixtures/pdf/files/encryption-state.positive.pdf"))
            .expect("the encryption fixture");
    let inspection = pdf::inspect(&encrypted);
    assert!(
        inspection.unreadable.is_none(),
        "the fixture was meant to parse: {:?}",
        inspection.unreadable
    );
    let (reason, message) = inspection
        .coverage
        .skipped
        .get("pdf.text_layer")
        .unwrap_or_else(|| {
            panic!(
                "pdf.text_layer should have skipped; coverage was {:?}",
                inspection.coverage
            )
        });
    assert_eq!(
        reason.as_str(),
        "blocked_by_encryption",
        "the skip must name a reason the result schema allows"
    );
    assert!(
        message.len() > 10,
        "the skip message is too thin to act on: {message:?}"
    );
    assert!(
        !inspection.coverage.completed.contains("pdf.text_layer"),
        "a detector was both skipped and completed"
    );

    // And a document with no pages completes rather than skipping: there is no
    // text because there are no pages, which is a finding of nothing, not a gap.
    let pageless = build_pdf(&[
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [] /Count 0 >>",
    ]);
    let pageless = pdf::inspect(&pageless);
    assert!(
        pageless.coverage.completed.contains("pdf.text_layer"),
        "a pageless document should complete, not skip: {:?}",
        pageless.coverage
    );
}

/// A document that parses and yields nothing is not a document with no findings.
///
/// ADR 0002 records that strict loading turns the off-by-one cross-reference
/// case into a refusal. It does not close the class: a structurally valid file
/// whose cross-reference table declares no objects loads successfully, in
/// strict mode, with nothing in it — measured, after a mutation removing the
/// checker's own guard survived every other input.
#[test]
fn a_document_that_parses_to_nothing_is_not_a_clean_document() {
    let empty_xref = b"%PDF-1.7\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 /Root 1 0 R >>\nstartxref\n9\n%%EOF\n".to_vec();
    let inspection = pdf::inspect(&empty_xref);
    assert!(
        inspection.unreadable.is_some(),
        "a file that parsed to no objects was treated as readable"
    );
    assert!(
        inspection.coverage.completed.is_empty(),
        "detectors completed against a document with nothing in it: {:?}",
        inspection.coverage.completed
    );
    assert_eq!(
        inspection.coverage.failed.len(),
        pdf::declared_detectors().len(),
        "every detector must be recorded as failed, not quietly absent"
    );
}

/// A document that talks about PDFs is not a document that was appended to.
///
/// The detector counted the words `trailer` and `startxref` anywhere in the
/// file, so a one-revision document whose page text explains PDF internals was
/// reported as incrementally updated - and that is the one category the rules
/// table escalates.
#[test]
fn words_in_the_page_text_are_not_a_second_revision() {
    let text = "BT /F1 12 Tf 72 720 Td (The trailer follows startxref in every PDF.) Tj ET";
    let doc = build_pdf(&[
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        &format!("<< /Length {} >>\nstream\n{text}\nendstream", text.len()),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]);
    let inspection = pdf::inspect(&doc);
    assert!(
        inspection.unreadable.is_none(),
        "the document was meant to parse: {:?}",
        inspection.unreadable
    );
    let claimed: Vec<&str> = inspection
        .detected
        .iter()
        .filter(|d| d.category == "incremental_update")
        .map(|d| d.value.as_str())
        .collect();
    assert!(
        claimed.is_empty(),
        "a single-revision document was reported as appended to: {claimed:?}"
    );

    // And the fixture that really was appended to is still found, so the fix
    // did not buy silence by detecting nothing.
    let real = all_fixtures()
        .into_iter()
        .find(|f| f.name == "incremental-update.positive.pdf")
        .expect("the fixture");
    assert!(
        real.inspection
            .detected
            .iter()
            .any(|d| d.category == "incremental_update"),
        "the genuine incremental update stopped being detected"
    );
}

/// What "text beneath an apparent redaction" means, case by case.
///
/// The fixture pair has one shape: text, then a rectangle over it. Three others
/// matter and none of them were covered — a rectangle drawn *first* is a
/// background and was reported as a redaction, text positioned by a transform
/// was missed entirely, and rotated content was silently answered "nothing
/// here", which §17.1 counts as a release blocker rather than a gap.
#[test]
fn a_covering_rectangle_is_judged_by_order_and_by_where_it_lands() {
    let page = |content: &str| {
        build_pdf(&[
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
            &format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        ])
    };
    let covered = |content: &str| {
        let r = pdf::inspect(&page(content));
        assert!(r.unreadable.is_none(), "meant to parse: {:?}", r.unreadable);
        (
            r.detected
                .iter()
                .filter(|d| d.category == "text_under_redaction")
                .count(),
            r.coverage.failed.get("pdf.text_layer").cloned(),
        )
    };

    let (hits, failed) =
        covered("BT /F1 12 Tf 72 720 Td (Claimant) Tj ET\n0 0 0 rg 70 715 200 18 re f");
    assert_eq!(
        (hits, failed.is_some()),
        (1, false),
        "text then a rectangle over it"
    );

    let (hits, _) = covered("0 0 0 rg 70 715 200 18 re f\nBT /F1 12 Tf 72 720 Td (Claimant) Tj ET");
    assert_eq!(
        hits, 0,
        "a rectangle drawn before the text is a background, not a redaction"
    );

    let (hits, _) = covered(
        "q 1 0 0 1 72 720 cm BT /F1 12 Tf 0 0 Td (Claimant) Tj ET Q\n0 0 0 rg 70 715 200 18 re f",
    );
    assert_eq!(
        hits, 1,
        "text positioned by a transform is still text under the rectangle"
    );

    let (hits, _) =
        covered("BT /F1 12 Tf 1 0 0 1 72 720 Tm (Claimant) Tj ET\n0 0 0 rg 70 715 200 18 re f");
    assert_eq!(hits, 1, "Tm positions text as surely as Td");

    let (hits, _) = covered("BT /F1 12 Tf 72 720 Td (Claimant) Tj ET\n0 0 0 rg 70 100 200 18 re f");
    assert_eq!(hits, 0, "a rectangle elsewhere on the page covers nothing");

    // Rotation is not reasoned about, and saying nothing about it would be a
    // silent miss. It fails, with a reason.
    let (hits, failed) = covered(
        "q 0 1 -1 0 0 0 cm BT /F1 12 Tf 72 720 Td (Claimant) Tj ET Q\n0 0 0 rg 70 715 200 18 re f",
    );
    assert_eq!(hits, 0);
    let (code, message) = failed.expect("rotated content must be refused rather than answered");
    assert_eq!(code.as_str(), "malformed_input");
    assert!(
        message.contains("rotates or skews"),
        "the reason does not say what happened: {message}"
    );
}

/// The content-stream operators a real page uses, which the fixture pair does
/// not.
///
/// The fixtures each hold one `Tj` after one `Td`, so a detector that treated
/// `Td` as an absolute coordinate, ignored render mode 7, dropped every `re`
/// but the last, never unwrapped a `TJ` array and did not know `'` existed
/// passed all of them.
#[test]
fn the_text_layer_reads_the_operators_a_page_actually_uses() {
    let page = |content: &str| {
        build_pdf(&[
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
            &format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        ])
    };
    let read = |content: &str| {
        let r = pdf::inspect(&page(content));
        assert!(r.unreadable.is_none(), "meant to parse: {:?}", r.unreadable);
        assert!(
            !r.coverage.failed.contains_key("pdf.text_layer"),
            "the detector failed: {:?}",
            r.coverage.failed.get("pdf.text_layer")
        );
        let hidden: Vec<String> = r
            .detected
            .iter()
            .filter(|d| d.category == "hidden_text")
            .map(|d| d.value.clone())
            .collect();
        let covered: Vec<String> = r
            .detected
            .iter()
            .filter(|d| d.category == "text_under_redaction")
            .map(|d| d.value.clone())
            .collect();
        (hidden, covered)
    };

    // Render mode 7 paints nothing and adds to the clip: as invisible as 3.
    let (hidden, _) = read("BT /F1 12 Tf 7 Tr 72 720 Td (Secret) Tj ET");
    assert_eq!(hidden, ["Secret"], "render mode 7 is invisible");

    // The render mode is graphics state, so Q restores it.
    let (hidden, _) = read(
        "q BT /F1 12 Tf 3 Tr 72 720 Td (Inside) Tj ET Q BT /F1 12 Tf 72 700 Td (Outside) Tj ET",
    );
    assert_eq!(hidden, ["Inside"], "an invisible mode leaked past its Q");

    // Td displaces the line matrix; two of them accumulate. The second run
    // lands at 72,706 - under the rectangle - and the first does not.
    let (_, covered) =
        read("BT /F1 12 Tf 72 720 Td (One) Tj 0 -14 Td (Two) Tj ET\n0 0 0 rg 70 700 200 18 re f");
    assert_eq!(covered, ["Two"], "Td was treated as an absolute coordinate");

    let (hidden, _) = read("BT /F1 12 Tf 3 Tr 72 720 Td [(Sec) -20 (ret)] TJ ET");
    assert_eq!(hidden, ["Sec", "ret"], "a TJ array was not unwrapped");

    let (hidden, _) = read("BT /F1 12 Tf 14 TL 3 Tr 72 720 Td (First) Tj (Second) ' ET");
    assert_eq!(hidden, ["First", "Second"], "the ' operator shows text too");

    // Several subpaths, one fill: all of them are painted.
    let (_, covered) = read(
        "BT /F1 12 Tf 72 720 Td (Covered) Tj ET\n0 0 0 rg 300 300 20 20 re 70 715 200 18 re f",
    );
    assert_eq!(
        covered,
        ["Covered"],
        "only the last rectangle of a path was kept"
    );

    // A path that is not filled covers nothing.
    let (_, covered) = read("BT /F1 12 Tf 72 720 Td (Uncovered) Tj ET\n70 715 200 18 re n");
    assert!(
        covered.is_empty(),
        "an unfilled path was treated as a covering shape"
    );

    let (_, covered) = read("BT /F1 12 Tf 72 720 Td (Covered) Tj ET\n0 0 0 rg 70 715 200 18 re B*");
    assert_eq!(covered, ["Covered"], "B* fills as surely as f");
}

/// Structures the fixtures do not have, each of which produced silence.
///
/// A name tree that branches, a form whose fields are grouped, a text string
/// that is not UTF-8, and a file written with classic Mac line endings. Every
/// one of them came back as "ran, found nothing" - which §17.1 counts as a
/// release blocker rather than a gap, because nothing distinguishes it from a
/// clean document.
#[test]
fn shapes_the_fixtures_do_not_have_are_read_rather_than_missed() {
    // An embedded-file name tree that branches through /Kids.
    let tree = build_pdf(&[
        "<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Kids [4 0 R] >> >> >>",
        "<< /Type /Pages /Kids [] /Count 0 >>",
        "<< /Type /Filespec /F (payroll.csv) >>",
        "<< /Names [(payroll.csv) 3 0 R] >>",
    ]);
    let found: Vec<String> = pdf::inspect(&tree)
        .detected
        .iter()
        .filter(|d| d.category == "embedded_file")
        .map(|d| d.value.clone())
        .collect();
    assert_eq!(
        found,
        ["payroll.csv"],
        "a branching name tree was read as empty"
    );

    // A form whose field sits under a parent's /Kids, with the name inherited.
    let form = build_pdf(&[
        "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [3 0 R] >> >>",
        "<< /Type /Pages /Kids [] /Count 0 >>",
        "<< /T (applicant) /Kids [4 0 R] >>",
        "<< /T (national_id) /V (QQ-123456-C) >>",
    ]);
    let inspection = pdf::inspect(&form);
    let values: Vec<String> = inspection
        .detected
        .iter()
        .filter(|d| d.category == "form_field_value")
        .map(|d| d.value.clone())
        .collect();
    let names: Vec<String> = inspection
        .detected
        .iter()
        .filter(|d| d.category == "form_field_name")
        .map(|d| d.value.clone())
        .collect();
    assert_eq!(
        values,
        ["QQ-123456-C"],
        "a grouped form field was read as empty"
    );
    assert!(
        names.contains(&"applicant.national_id".to_string()),
        "the inherited field name was not assembled: {names:?}"
    );

    // /Author as UTF-16BE behind a byte-order mark. from_utf8_lossy turned this
    // into replacement characters, and the value is the evidence a person sees.
    let mut utf16 = String::from("%PDF-1.7\n");
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [] /Count 0 >>",
        "<< /Author <FEFF65874EE3> >>",
    ];
    let mut offsets = Vec::new();
    for (i, body) in objects.iter().enumerate() {
        offsets.push(utf16.len());
        utf16.push_str(&format!("{} 0 obj\n{body}\nendobj\n", i + 1));
    }
    let xref_at = utf16.len();
    utf16.push_str(&format!(
        "xref\n0 {}\n0000000000 65535 f \n",
        objects.len() + 1
    ));
    for offset in &offsets {
        utf16.push_str(&format!("{offset:010} 00000 n \n"));
    }
    utf16.push_str(&format!(
        "trailer\n<< /Size {} /Root 1 0 R /Info 3 0 R >>\nstartxref\n{xref_at}\n%%EOF\n",
        objects.len() + 1
    ));
    let authors: Vec<String> = pdf::inspect(utf16.as_bytes())
        .detected
        .iter()
        .filter(|d| d.category == "document_author")
        .map(|d| d.value.clone())
        .collect();
    assert_eq!(
        authors,
        ["\u{6587}\u{4ee3}"],
        "a UTF-16BE text string was not decoded"
    );

    // The incremental-update fixture with every newline replaced by a carriage
    // return: the same file, written the way a classic Mac tool writes it.
    let original =
        std::fs::read(repo_root().join("fixtures/pdf/files/incremental-update.positive.pdf"))
            .expect("the fixture");
    let cr_only: Vec<u8> = original
        .iter()
        .map(|b| if *b == b'\n' { b'\r' } else { *b })
        .collect();
    let updates = pdf::inspect(&cr_only)
        .detected
        .iter()
        .filter(|d| d.category == "incremental_update")
        .count();
    assert_eq!(
        updates, 1,
        "carriage returns hid the second cross-reference section"
    );
}

/// A minimal PDF whose cross-reference offsets are computed from the bytes.
///
/// Hand-written offsets are exactly what ADR 0002's `xref-offsets-off-by-one`
/// case is about, and strict loading refuses them - as it refused the first
/// version of the document above.
fn build_pdf(objects: &[&str]) -> Vec<u8> {
    let mut out = String::from("%PDF-1.7\n");
    let mut offsets = Vec::new();
    for (index, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.push_str(&format!("{} 0 obj\n{body}\nendobj\n", index + 1));
    }
    let xref_at = out.len();
    out.push_str(&format!(
        "xref\n0 {}\n0000000000 65535 f \n",
        objects.len() + 1
    ));
    for offset in &offsets {
        out.push_str(&format!("{offset:010} 00000 n \n"));
    }
    out.push_str(&format!(
        "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n",
        objects.len() + 1
    ));
    out.into_bytes()
}
