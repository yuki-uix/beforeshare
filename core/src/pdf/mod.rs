//! The deterministic PDF checker (§7.1).
//!
//! Its job is to see, not to present: each detector reports what it found and
//! where, and whether it ran. Turning that into a canonical inspection result -
//! masking evidence, assigning severity, naming a remediation - is a separate
//! concern with its own guarantees, and mixing the two would make "did the
//! checker see it" untestable without also being right about how it reads.
//!
//! The categories, locations and detector names are not written here. They come
//! from `schemas/v1/pdf-detection-rules.json`, which maps each §7.1 item to
//! them, and from `schemas/v1/detector-registry.json`, which says what each
//! detector may emit. A category this module invents, or one the registry lists
//! and nothing here can produce, fails a check rather than passing quietly.
use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;

mod detectors;

const DETECTION_RULES: &str = include_str!("../../../schemas/v1/pdf-detection-rules.json");
const REGISTRY: &str = include_str!("../../../schemas/v1/detector-registry.json");

/// Why a detector did not produce findings.
///
/// §17.1 counts a missed detection as a release blocker, so "it did not run" and
/// "it ran and found nothing" must never look alike. Every detector returns one
/// of these or a list, and the coverage report carries the difference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotRun {
    /// The detector does not apply to this document, with the reason.
    Skipped(&'static str),
    /// The detector applied and could not finish, with the reason.
    Failed(String),
}

/// One thing a detector found, and where.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detected {
    pub category: String,
    pub detector: String,
    pub location: Location,
    /// The value as it appears in the document, unmasked. Masking belongs to the
    /// layer that presents a finding, and doing it here would mean the detector
    /// tests could not check what was actually read.
    pub value: String,
}

/// Where in the document, in the vocabulary `location.schema.json` uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Location {
    pub kind: String,
    pub page: Option<u32>,
    pub object_number: Option<u32>,
    pub field: Option<String>,
}

impl Location {
    fn of(kind: &str) -> Self {
        Self {
            kind: kind.to_string(),
            page: None,
            object_number: None,
            field: None,
        }
    }
    fn object(kind: &str, number: u32) -> Self {
        Self {
            object_number: Some(number),
            ..Self::of(kind)
        }
    }
    fn field(kind: &str, name: &str) -> Self {
        Self {
            field: Some(name.to_string()),
            ..Self::of(kind)
        }
    }
    fn on_page(kind: &str, page: u32, number: u32) -> Self {
        Self {
            page: Some(page),
            object_number: Some(number),
            ..Self::of(kind)
        }
    }
}

/// Which detectors ran, which did not, and why not.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Coverage {
    pub completed: BTreeSet<String>,
    pub skipped: BTreeMap<String, String>,
    pub failed: BTreeMap<String, String>,
}

/// What one inspection produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inspection {
    pub detected: Vec<Detected>,
    pub coverage: Coverage,
    /// Present when the document could not be parsed at all. Every detector is
    /// then failed rather than completed with nothing: §17.1's zero-missed-
    /// detections claim is about documents that were read.
    pub unreadable: Option<String>,
}

#[derive(Deserialize)]
struct RulesFile {
    /// `$comment` lives alongside the items and is not one, so entries are
    /// read loosely and the `$`-prefixed keys dropped.
    mapping: BTreeMap<String, serde_json::Value>,
}

impl RulesFile {
    fn items(&self) -> impl Iterator<Item = MappedItem> + '_ {
        self.mapping
            .iter()
            .filter(|(k, _)| !k.starts_with('$'))
            .filter_map(|(_, v)| serde_json::from_value(v.clone()).ok())
    }
}

#[derive(Deserialize)]
struct MappedItem {
    #[serde(default)]
    categories: Vec<String>,
    #[serde(default)]
    location: Option<String>,
    #[serde(default)]
    detector: Option<String>,
}

/// The location kind for a detector's own document-level findings, read from
/// the table rather than written here.
fn location_for(category: &str) -> String {
    location_kind_for(category)
        .unwrap_or_else(|| panic!("{category} has no location in pdf-detection-rules.json"))
        .to_string()
}

#[derive(Deserialize)]
struct RegistryFile {
    detectors: BTreeMap<String, RegisteredDetector>,
}

#[derive(Deserialize)]
struct RegisteredDetector {
    emits: Vec<String>,
}

fn rules() -> &'static RulesFile {
    static CACHE: std::sync::OnceLock<RulesFile> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| serde_json::from_str(DETECTION_RULES).expect("pdf-detection-rules.json"))
}

fn registry() -> &'static RegistryFile {
    static CACHE: std::sync::OnceLock<RegistryFile> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| serde_json::from_str(REGISTRY).expect("detector-registry.json"))
}

/// The PDF detectors the rule table names.
///
/// A set, so the order is the name's, not the table's - the comment used to say
/// "in the order they are declared", which a `BTreeSet` cannot honour.
pub fn declared_detectors() -> BTreeSet<&'static str> {
    rules()
        .items()
        .filter_map(|item| item.detector)
        .map(|d| Box::leak(d.into_boxed_str()) as &'static str)
        .collect()
}

/// Every category the registry says a `pdf.*` detector may emit.
pub fn declared_categories() -> BTreeSet<&'static str> {
    registry()
        .detectors
        .iter()
        .filter(|(name, _)| name.starts_with("pdf."))
        .flat_map(|(_, d)| d.emits.iter().map(String::as_str))
        .collect()
}

/// The location kind the table gives for a category, so a detector cannot
/// invent one.
fn location_kind_for(category: &str) -> Option<&'static str> {
    rules()
        .items()
        .find(|item| item.categories.iter().any(|c| c == category))
        .and_then(|item| item.location)
        .map(|l| Box::leak(l.into_boxed_str()) as &'static str)
}

/// Inspect one document.
///
/// Loaded with `strict: true` for the reason ADR 0002 records: lenient parsing
/// answers Ok with no objects for a file whose cross-reference table is wrong,
/// and every detector would then complete having seen nothing.
pub fn inspect(bytes: &[u8]) -> Inspection {
    let options = lopdf::LoadOptions {
        strict: true,
        ..Default::default()
    };
    let document = match lopdf::Document::load_mem_with_options(bytes, options) {
        Ok(doc) => doc,
        Err(e) => {
            let reason = format!("this document could not be parsed: {e}");
            let mut coverage = Coverage::default();
            for name in declared_detectors() {
                coverage.failed.insert(name.to_string(), reason.clone());
            }
            return Inspection {
                detected: Vec::new(),
                coverage,
                unreadable: Some(reason),
            };
        }
    };

    // A parse that succeeds and yields nothing is the failure ADR 0002 names.
    // Strict loading should already refuse it; this is the assertion that the
    // checker never reports "nothing found" about a document it did not read.
    if document.objects.is_empty() {
        let reason = "this document parsed to no objects at all".to_string();
        let mut coverage = Coverage::default();
        for name in declared_detectors() {
            coverage.failed.insert(name.to_string(), reason.clone());
        }
        return Inspection {
            detected: Vec::new(),
            coverage,
            unreadable: Some(reason),
        };
    }

    // The document *and* the bytes. Some §7.1 facts are about the file's
    // structure rather than about an object in it - an incremental update is
    // one, and lopdf resolves the cross-reference chain and drops the marker,
    // so the object model cannot answer it at all.
    let source = detectors::Source {
        document: &document,
        bytes,
    };
    let mut detected = Vec::new();
    let mut coverage = Coverage::default();
    for (name, run) in detectors::all() {
        match run(&source) {
            Ok(mut found) => {
                coverage.completed.insert(name.to_string());
                detected.append(&mut found);
            }
            Err(NotRun::Skipped(why)) => {
                coverage.skipped.insert(name.to_string(), why.to_string());
            }
            Err(NotRun::Failed(why)) => {
                coverage.failed.insert(name.to_string(), why);
            }
        }
    }
    Inspection {
        detected,
        coverage,
        unreadable: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The table names the detectors; this module implements them. Either side
    /// gaining an entry the other lacks is a gap, and the two-way check is what
    /// makes adding one a decision rather than an omission.
    #[test]
    fn every_declared_detector_is_implemented_and_no_others() {
        let declared = declared_detectors();
        let implemented: BTreeSet<&str> = detectors::all().into_iter().map(|(n, _)| n).collect();
        assert_eq!(
            declared, implemented,
            "the rule table and this module disagree about which detectors exist"
        );
    }

    /// A category a detector emits that no table declares would travel all the
    /// way into a result nobody can interpret.
    #[test]
    fn every_location_kind_comes_from_the_table() {
        for category in declared_categories() {
            assert!(
                location_kind_for(category).is_some(),
                "{category} is emitted by a registered detector and has no location in the mapping"
            );
        }
    }
}
