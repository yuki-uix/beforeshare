//! Turning what the detectors saw into the canonical inspection result (§8.1).
//!
//! Nothing here decides anything about a finding that a table has already
//! decided. The severity, group and certainty come from
//! `category-defaults.json`, the masking policy from `evidence-policy.json`,
//! the detector's version from `detector-registry.json`, and the status from
//! the decision table in `docs/contracts/status-and-exit-codes.md`. A value
//! invented here is a value no document explains.
use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::masking;
use crate::pdf::{Inspection, Location, SkipReason};

const DEFAULTS: &str = include_str!("../../schemas/v1/category-defaults.json");
const REGISTRY: &str = include_str!("../../schemas/v1/detector-registry.json");
const STATUS_INPUTS: &str = include_str!("../../schemas/v1/status-inputs.json");
const DETECTION_RULES: &str = include_str!("../../schemas/v1/pdf-detection-rules.json");

#[derive(Deserialize)]
struct DefaultsFile {
    categories: BTreeMap<String, CategoryDefaults>,
}

#[derive(Deserialize, Clone)]
struct CategoryDefaults {
    group: String,
    #[serde(rename = "defaultCertainty")]
    default_certainty: String,
    #[serde(rename = "defaultSeverity")]
    default_severity: String,
}

#[derive(Deserialize)]
struct RegistryFile {
    detectors: BTreeMap<String, RegisteredDetector>,
    parsers: BTreeMap<String, RegisteredDetector>,
}

#[derive(Deserialize)]
struct RegisteredDetector {
    version: String,
}

#[derive(Deserialize)]
struct StatusInputs {
    #[serde(rename = "blockingRule")]
    blocking_rule: BlockingRule,
    #[serde(rename = "skipReasons")]
    skip_reasons: BTreeMap<String, SkipRow>,
}

#[derive(Deserialize)]
struct BlockingRule {
    severity: String,
    certainty: String,
}

#[derive(Deserialize)]
struct SkipRow {
    #[serde(rename = "reducesCoverage")]
    reduces_coverage: bool,
}

fn defaults() -> &'static BTreeMap<String, CategoryDefaults> {
    static CACHE: std::sync::OnceLock<BTreeMap<String, CategoryDefaults>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| {
        serde_json::from_str::<DefaultsFile>(DEFAULTS)
            .expect("category-defaults.json")
            .categories
    })
}

fn registry_file() -> &'static RegistryFile {
    static CACHE: std::sync::OnceLock<RegistryFile> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| serde_json::from_str(REGISTRY).expect("detector-registry.json"))
}

fn registry() -> &'static BTreeMap<String, RegisteredDetector> {
    &registry_file().detectors
}

/// What severity the rules table raises a category to, when its condition holds.
///
/// Read rather than written here: `pdf-detection-rules.json` says the raise is
/// conditional - "a previous revision holds values the current one removes",
/// never for the presence of an update - and hard-coding critical would be this
/// epic overruling E1 in a file E1 would not think to read.
fn raised_severity(category: &str) -> Option<String> {
    static CACHE: std::sync::OnceLock<BTreeMap<String, String>> = std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| {
            let rules: Value = serde_json::from_str(DETECTION_RULES).expect("detection rules");
            rules["escalation"]
                .as_object()
                .map(|m| {
                    m.iter()
                        .filter(|(k, _)| !k.starts_with('$'))
                        .filter_map(|(k, v)| {
                            v["raiseTo"].as_str().map(|r| (k.clone(), r.to_string()))
                        })
                        .collect()
                })
                .unwrap_or_default()
        })
        .get(category)
        .cloned()
}

fn status_inputs() -> &'static StatusInputs {
    static CACHE: std::sync::OnceLock<StatusInputs> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| serde_json::from_str(STATUS_INPUTS).expect("status-inputs.json"))
}

/// Whether a skip leaves a hole in what was checked.
///
/// Read from the table rather than judged here: "the detector correctly did not
/// apply" and "the check did not happen" are both skips, and only the second
/// makes a result partial.
pub fn reduces_coverage(reason: SkipReason) -> bool {
    reduces_coverage_named(reason.as_str())
}

/// The same question for a reason this layer names rather than a detector: the
/// OCR gap is added here, and it has to be classified by the same table as
/// everything else.
fn reduces_coverage_named(reason: &str) -> bool {
    status_inputs()
        .skip_reasons
        .get(reason)
        .unwrap_or_else(|| panic!("{reason} is not classified in status-inputs.json"))
        .reduces_coverage
}

/// A finding blocks only when it is both critical and deterministic.
fn is_blocking(finding: &Value) -> bool {
    let rule = &status_inputs().blocking_rule;
    finding["severity"] == *rule.severity && finding["certainty"] == *rule.certainty
}

/// What the file was, which the result must carry to be interpretable at all.
pub struct InputFacts {
    pub path: String,
    pub media_type: String,
    pub sha256: String,
    pub size_bytes: u64,
}

/// Assemble the result.
///
/// `run_id`, `started_at` and `duration_ms` are the caller's: a core that
/// invented a clock would make two runs of the same bytes differ for a reason
/// nobody chose.
pub fn assemble(
    inspection: &Inspection,
    input: &InputFacts,
    run_id: &str,
    started_at: &str,
    duration_ms: u64,
) -> Result<Value, String> {
    let mut findings = Vec::new();
    for (index, detected) in inspection.detected.iter().enumerate() {
        let category = &detected.category;
        let row = defaults()
            .get(category)
            .ok_or_else(|| format!("{category} has no row in category-defaults.json"))?;
        let policy = masking::policy_for(category)
            .ok_or_else(|| format!("{category} has no evidence policy"))?;
        let masked = masking::mask(&detected.value, policy)?;
        let version = registry()
            .get(&detected.detector)
            .ok_or_else(|| format!("{} is not in the detector registry", detected.detector))?
            .version
            .clone();

        // Each kind has its own required fields, so the shape comes from the
        // variant rather than from a struct with everything optional.
        let location = match &detected.location {
            Location::PdfMetadata { field } => {
                json!({ "kind": "pdf_metadata", "field": field })
            }
            Location::PdfAnnotation {
                page,
                object_number,
                subtype,
            } => {
                let mut v = json!({ "kind": "pdf_annotation", "page": page });
                if let Some(n) = object_number {
                    v["objectNumber"] = json!(n);
                }
                if let Some(s) = subtype {
                    v["subtype"] = json!(s);
                }
                v
            }
            Location::PdfFormField { field_name, page } => {
                let mut v = json!({ "kind": "pdf_form_field", "fieldName": field_name });
                if let Some(p) = page {
                    v["page"] = json!(p);
                }
                v
            }
            Location::PdfEmbeddedFile { index, name } => {
                let mut v = json!({ "kind": "pdf_embedded_file", "index": index });
                if let Some(n) = name {
                    v["name"] = json!(n);
                }
                v
            }
            Location::PdfAction {
                trigger,
                page,
                object_number,
            } => {
                let mut v = json!({ "kind": "pdf_action", "trigger": trigger.as_str() });
                if let Some(p) = page {
                    v["page"] = json!(p);
                }
                if let Some(n) = object_number {
                    v["objectNumber"] = json!(n);
                }
                v
            }
            Location::PdfTextLayer { page } => {
                json!({ "kind": "pdf_text_layer", "page": page })
            }
            Location::FileStructure { detail, revision } => {
                let mut v = json!({ "kind": "file_structure", "detail": detail.as_str() });
                if let Some(r) = revision {
                    v["revision"] = json!(r);
                }
                v
            }
        };

        let mut evidence = json!({
            "displayValue": masked.display_value,
            "redacted": masked.redacted,
            "maskPolicy": masked.mask_policy,
        });
        if masked.truncated {
            evidence["truncated"] = json!(true);
        }

        // E1's default unless the rules table names a raise AND the detector
        // established that the raise's condition holds. Both halves are needed:
        // a table that raises unconditionally would make every incremental
        // update critical, which the table explicitly refuses.
        let severity = match (detected.hides_a_removal, raised_severity(category)) {
            (true, Some(raised)) => raised,
            _ => row.default_severity.clone(),
        };
        findings.push(json!({
            "id": format!("finding-{}", index + 1),
            "category": category,
            "group": row.group,
            "severity": severity,
            "certainty": row.default_certainty,
            "detector": { "id": detected.detector, "version": version },
            "location": location,
            "evidence": evidence,
            "message": message_for(category, detected.location.kind()),
            // Every remediation action in the capability declaration is
            // `not_implemented`, waiting on #7. Saying `supported: false` is the
            // truth, and the schema requires the reason with it: "not supported"
            // without a reason is a shrug, and the enum makes it a statement.
            "remediation": {
                "supported": false,
                "unsupportedReason": "not_implemented",
            },
        }));
    }

    let completed: Vec<&str> = inspection
        .coverage
        .completed
        .iter()
        .map(String::as_str)
        .collect();
    let mut skipped: Vec<Value> = inspection
        .coverage
        .skipped
        .iter()
        .map(|(detector, (reason, message))| {
            json!({ "detector": detector, "reason": reason.as_str(), "message": message })
        })
        .collect();
    // §7.1's twelfth item is image-only pages through local OCR, and OCR is
    // E5's. Leaving it out entirely would let a result say `no_findings` about a
    // page nobody read; naming it as unavailable says what actually happened.
    if inspection.has_images {
        skipped.push(json!({
            "detector": "ocr.visible_text",
            "reason": "dependency_unavailable",
            "message": "local OCR is not implemented yet (#6), so text that exists only inside images was not read",
        }));
    }
    let failed: Vec<Value> = inspection
        .coverage
        .failed
        .iter()
        .map(|(detector, (code, message))| {
            json!({ "detector": detector, "errorCode": code.as_str(), "message": message })
        })
        .collect();

    // Derived from the coverage that was just built, not from a second copy of
    // the conditions that built it. The two were written separately and could
    // disagree: coverage could name a skip that reduces coverage while the
    // status computation never saw it, so a result could list a gap and still
    // be called clean. Flipping one of the two conditions changed nothing,
    // which is how the duplication showed itself.
    let gaps: Vec<String> = skipped
        .iter()
        .filter(|entry| {
            entry["reason"]
                .as_str()
                .map(reduces_coverage_named)
                .unwrap_or(false)
        })
        .filter_map(|entry| entry["detector"].as_str().map(str::to_string))
        .chain(inspection.coverage.failed.keys().cloned())
        .collect();

    let status = decide_status(
        inspection.coverage.completed.len(),
        &gaps,
        &findings,
        &input.media_type,
    );

    // §14.1 wants the parser's version as well as the detectors': it is the
    // layer most likely to change what was found, and the first version of this
    // omitted it - the schema said so before anyone had to notice.
    let detector_versions: Vec<Value> = inspection
        .coverage
        .completed
        .iter()
        .filter_map(|name| {
            registry()
                .get(name)
                .map(|d| json!({ "id": name, "version": d.version }))
        })
        .collect();
    let parsers: Vec<Value> = registry_file()
        .parsers
        .iter()
        .filter(|(id, _)| id.starts_with("pdf."))
        .map(|(id, p)| json!({ "id": id, "version": p.version }))
        .collect();

    Ok(json!({
        "schemaVersion": "1.0",
        "runId": run_id,
        "input": {
            "path": input.path,
            "mediaType": input.media_type,
            "sha256": input.sha256,
            "sizeBytes": input.size_bytes,
        },
        "status": status.0,
        "coverage": { "completed": completed, "skipped": skipped, "failed": failed },
        "findings": findings,
        // §7.1's image-only item needs OCR, which E5 owns; a result that said
        // nothing about it would be claiming the page was read.
        "limitations": limitations_for(inspection),
        "versions": {
            "core": env!("CARGO_PKG_VERSION"),
            "parsers": parsers,
            "detectors": detector_versions,
        },
        "startedAt": started_at,
        "durationMs": duration_ms,
    }))
}

/// The status decision table, row for row.
///
/// The order of these branches IS the table in
/// `docs/contracts/status-and-exit-codes.md`. Reordering one without the other
/// produces a product the document does not describe.
pub fn decide_status(
    completed: usize,
    gaps: &[String],
    findings: &[Value],
    media_type: &str,
) -> (&'static str, String) {
    // 1. Out of scope, checked before the zero-detector case: an out-of-scope
    //    file naturally has no completed detectors, and calling that `failed`
    //    would blame the run for a property of the input.
    if media_type != "application/pdf" {
        return (
            "unsupported",
            "the media type is outside the supported set".into(),
        );
    }
    // 2. In scope and nothing completed: the result describes nothing.
    if completed == 0 {
        return (
            "failed",
            "no detector completed, so the result describes nothing about the file".into(),
        );
    }
    let blocking: Vec<&str> = findings
        .iter()
        .filter(|f| is_blocking(f))
        .filter_map(|f| f["category"].as_str())
        .collect();
    // 3. A blocking finding outranks incomplete coverage: incompleteness does
    //    not make a critical deterministic finding less true.
    if !blocking.is_empty() {
        return (
            "blocking_findings",
            format!(
                "{} critical deterministic finding(s): {}",
                blocking.len(),
                blocking.join(", ")
            ),
        );
    }
    // 4. Incomplete coverage outranks ordinary findings. `partial` is the only
    //    value that says "this list is not exhaustive", and someone who fixes
    //    three findings under a `review_required` headline would reasonably
    //    believe they were done.
    if !gaps.is_empty() {
        return (
            "partial",
            format!("checks did not run: {}", gaps.join(", ")),
        );
    }
    if !findings.is_empty() {
        return (
            "review_required",
            format!("{} finding(s) to review", findings.len()),
        );
    }
    // 5. The only state that may be presented as clean, and only because every
    //    branch above was ruled out.
    (
        "no_findings",
        "all applicable checks completed with nothing to report".into(),
    )
}

/// What the result must admit it did not do.
fn limitations_for(inspection: &Inspection) -> Vec<Value> {
    let mut out = Vec::new();
    if inspection
        .coverage
        .skipped
        .values()
        .any(|(reason, _)| *reason == SkipReason::BlockedByEncryption)
    {
        out.push(json!({
            "code": "encrypted_content_not_inspected",
            "impact": "coverage_incomplete",
            "affectedDetectors": ["pdf.text_layer"],
            "message": "the content streams are encrypted and were not decrypted, so text on the page was not read",
        }));
    }
    out
}

/// One sentence about what was found, in the terms §8.2 asks for.
fn message_for(category: &str, location_kind: &str) -> String {
    format!("{category} found in {location_kind}")
}
