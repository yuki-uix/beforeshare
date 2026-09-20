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
const LIMITS: &str = include_str!("../../../schemas/v1/limit-rules.json");

/// Why a detector did not produce findings.
///
/// §17.1 counts a missed detection as a release blocker, so "it did not run" and
/// "it ran and found nothing" must never look alike. Every detector returns one
/// of these or a list, and the coverage report carries the difference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotRun {
    /// The detector does not apply, named by the reason the result schema
    /// allows. Prose lived here first, and the result could not carry it: a
    /// coverage entry's reason is an enum, because a consumer has to decide
    /// whether the gap reduces coverage and cannot do that from a sentence.
    Skipped { reason: SkipReason, message: String },
    /// The detector applied and could not finish.
    Failed { code: FailureCode, message: String },
}

/// The reasons `schemas/v1/enums.schema.json` allows a detector to skip.
///
/// Only the ones this checker can honestly produce are here. Adding a variant
/// that the product cannot reach would be a coverage state nobody can observe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    NotApplicableToMediaType,
    BlockedByEncryption,
}

impl SkipReason {
    /// Every variant, so a list of them is derived rather than copied. A
    /// hand-written list does not fail when a variant is added: the one in the
    /// fixture test was missing a code the core had started producing, and a
    /// legitimate failure would have been reported as a contract violation.
    pub const ALL: &'static [Self] = &[Self::NotApplicableToMediaType, Self::BlockedByEncryption];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotApplicableToMediaType => "not_applicable_to_media_type",
            Self::BlockedByEncryption => "blocked_by_encryption",
        }
    }
}

/// The failure codes the result schema allows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureCode {
    ParserError,
    MalformedInput,
    /// Found while working, which is what makes it a failure rather than a
    /// skip: `limit-rules.json` puts `input_too_large` at skipped because the
    /// size is knowable before anything is attempted, and this one at failed
    /// because it is not.
    ResourceLimitExceeded,
    InternalError,
}

impl FailureCode {
    /// Every variant. See `SkipReason::ALL`.
    pub const ALL: &'static [Self] = &[
        Self::ParserError,
        Self::MalformedInput,
        Self::ResourceLimitExceeded,
        Self::InternalError,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ParserError => "parser_error",
            Self::MalformedInput => "malformed_input",
            Self::ResourceLimitExceeded => "resource_limit_exceeded",
            Self::InternalError => "internal_error",
        }
    }
}

/// One thing a detector found, and where.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detected {
    pub category: String,
    pub detector: String,
    pub location: Location,
    /// Whether this finding meets the condition the rules table names for
    /// raising its severity. The condition is per category and stated there;
    /// whether it holds is a fact only the detector can establish.
    pub hides_a_removal: bool,
    /// The value as it appears in the document, unmasked. Masking belongs to the
    /// layer that presents a finding, and doing it here would mean the detector
    /// tests could not check what was actually read.
    pub value: String,
    /// Who wrote this value.
    ///
    /// Two different things were being spelled the same way. "This document
    /// declares an /Encrypt dictionary" is a sentence a detector wrote and has
    /// nothing in it to hide; a form field's value is the document's, and
    /// showing it in full is a decision. Only the first may carry the one
    /// policy that shows a value unmasked, and the presentation layer refuses
    /// the second under it - a review found a whole JavaScript program
    /// serialised verbatim because the two were indistinguishable here.
    pub provenance: Provenance,
}

/// Where a finding's value came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provenance {
    /// Copied out of the document.
    Document,
    /// Written by the detector: a fixed fact about the file.
    Detector,
}

/// Where in the document, in the shape `location.schema.json` requires.
///
/// One variant per location kind, because the schema requires different fields
/// for each and a single struct with optional fields satisfied none of them: a
/// form-field location needs `fieldName`, an embedded file needs `index`, an
/// action needs `trigger`. The first version carried `page`/`objectNumber`/
/// `field` for everything and could not have validated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Location {
    /// `field` is the /Info key or XMP property.
    PdfMetadata {
        field: String,
    },
    PdfAnnotation {
        page: u32,
        object_number: Option<u32>,
        subtype: Option<String>,
    },
    /// `field_name` is the fully qualified name, parents joined with a dot.
    PdfFormField {
        field_name: String,
        page: Option<u32>,
    },
    /// `index` into the name tree, because a name is not unique and may itself
    /// disclose something.
    PdfEmbeddedFile {
        index: u32,
        name: Option<String>,
    },
    /// `trigger` says what runs the action - an open action and a link are
    /// different disclosures.
    PdfAction {
        trigger: Trigger,
        page: Option<u32>,
        object_number: Option<u32>,
    },
    PdfTextLayer {
        page: u32,
    },
    /// `detail` names what about the file's structure this is.
    FileStructure {
        detail: StructureDetail,
        revision: Option<u32>,
    },
}

/// What runs an action, in the words `location.schema.json` allows.
///
/// A string went here first and the schema refused it: a consumer deciding how
/// alarming an action is needs to know whether it runs on open or on a click,
/// and cannot read that from prose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    DocumentOpen,
    PageOpen,
    PageClose,
    Annotation,
    FormField,
    NamedAction,
}

impl Trigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DocumentOpen => "document_open",
            Self::PageOpen => "page_open",
            Self::PageClose => "page_close",
            Self::Annotation => "annotation",
            Self::FormField => "form_field",
            Self::NamedAction => "named_action",
        }
    }
}

/// What about the file's structure a finding is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StructureDetail {
    EncryptionDictionary,
    Permissions,
    SignatureDictionary,
    IncrementalUpdate,
}

impl StructureDetail {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::EncryptionDictionary => "encryption_dictionary",
            Self::Permissions => "permissions",
            Self::SignatureDictionary => "signature_dictionary",
            Self::IncrementalUpdate => "incremental_update",
        }
    }
}

impl Location {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::PdfMetadata { .. } => "pdf_metadata",
            Self::PdfAnnotation { .. } => "pdf_annotation",
            Self::PdfFormField { .. } => "pdf_form_field",
            Self::PdfEmbeddedFile { .. } => "pdf_embedded_file",
            Self::PdfAction { .. } => "pdf_action",
            Self::PdfTextLayer { .. } => "pdf_text_layer",
            Self::FileStructure { .. } => "file_structure",
        }
    }
}

/// Which detectors ran, which did not, and why not.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Coverage {
    pub completed: BTreeSet<String>,
    pub skipped: BTreeMap<String, (SkipReason, String)>,
    pub failed: BTreeMap<String, (FailureCode, String)>,
}

/// What one inspection produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inspection {
    pub detected: Vec<Detected>,
    pub coverage: Coverage,
    /// Whether the document holds an image, which is what decides whether local
    /// OCR had anything to do. Reporting OCR as a gap for a document with no
    /// images would make every text-only file partial - exactly what
    /// status-inputs.json warns trains people to ignore the state.
    pub has_images: bool,
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
#[cfg_attr(not(test), allow(dead_code))]
struct MappedItem {
    #[serde(default)]
    categories: Vec<String>,
    #[serde(default)]
    location: Option<String>,
    #[serde(default)]
    detector: Option<String>,
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
/// The location kind the table gives for a category.
///
/// Used by the two-way check below and nowhere else: the detectors carry their
/// location in the type now, so the table cannot be consulted at the point a
/// finding is built - it is consulted here instead, to prove every category the
/// registry can emit has a place the schema recognises.
#[cfg(test)]
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
    // The budget reaches the load as well. It bounds object and cross-reference
    // streams, which are expanded while the document is being built - before
    // any detector exists to refuse anything - and the field defaults to no
    // limit at all.
    let options = lopdf::LoadOptions {
        strict: true,
        max_decompressed_size: Some(decompression_budget(bytes.len())),
        ..Default::default()
    };
    let document = match lopdf::Document::load_mem_with_options(bytes, options) {
        Ok(doc) => doc,
        Err(e) => {
            let reason = format!("this document could not be parsed: {e}");
            let mut coverage = Coverage::default();
            for name in declared_detectors() {
                coverage.failed.insert(
                    name.to_string(),
                    (FailureCode::MalformedInput, reason.clone()),
                );
            }
            return Inspection {
                detected: Vec::new(),
                coverage,
                unreadable: Some(reason),
                has_images: false,
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
            coverage
                .failed
                .insert(name.to_string(), (FailureCode::ParserError, reason.clone()));
        }
        return Inspection {
            detected: Vec::new(),
            coverage,
            unreadable: Some(reason),
            has_images: false,
        };
    }

    // The document *and* the bytes. Some §7.1 facts are about the file's
    // structure rather than about an object in it - an incremental update is
    // one, and lopdf resolves the cross-reference chain and drops the marker,
    // so the object model cannot answer it at all.
    let source = detectors::Source {
        document: &document,
        bytes,
        decompression_budget: decompression_budget(bytes.len()),
    };
    let mut detected = Vec::new();
    let mut coverage = Coverage::default();
    for (name, run) in detectors::all() {
        match run(&source) {
            Ok(mut found) => {
                coverage.completed.insert(name.to_string());
                detected.append(&mut found);
            }
            Err(NotRun::Skipped { reason, message }) => {
                coverage.skipped.insert(name.to_string(), (reason, message));
            }
            Err(NotRun::Failed { code, message }) => {
                coverage.failed.insert(name.to_string(), (code, message));
            }
        }
    }
    // An image XObject anywhere is enough: OCR reads pictures, and whether one
    // sits on a page or inside a form is not this question.
    let has_images = document.objects.values().any(|object| {
        let dict = match object {
            lopdf::Object::Dictionary(d) => Some(d),
            lopdf::Object::Stream(st) => Some(&st.dict),
            _ => None,
        };
        // Through the reference. A /Subtype may be an indirect object like any
        // other value, and reading the reference as a name answers "not an
        // image" - which drops the OCR gap from the coverage and can make a
        // scanned page report as a document with nothing in it.
        dict.and_then(|d| d.get(b"Subtype").ok())
            .and_then(|v| document.dereference(v).ok())
            .and_then(|(_, v)| v.as_name().ok())
            .map(|n| n == b"Image")
            .unwrap_or(false)
    });
    Inspection {
        detected,
        coverage,
        unreadable: None,
        has_images,
    }
}

/// How much one page may decompress to, from the expansion ratio the limit
/// table declares.
///
/// The ratio is marked `provisional` there and #56 owes the measured number;
/// reading it rather than writing one here means the measurement lands in one
/// place when it arrives.
fn decompression_budget(input_bytes: usize) -> usize {
    static RATIO: std::sync::OnceLock<f64> = std::sync::OnceLock::new();
    let ratio = *RATIO.get_or_init(|| {
        let limits: serde_json::Value = serde_json::from_str(LIMITS).expect("limit-rules.json");
        limits["budgets"]["expansionRatio"]["default"]
            .as_f64()
            .expect("the table declares an expansion ratio")
    });
    // A floor, because a tiny document still has a legitimate page or two: the
    // ratio bounds growth, not absolute size.
    ((input_bytes as f64 * ratio) as usize).max(1 << 20)
}

/// A whole-number budget from the limit table, by name.
///
/// Both of these are `provisional` there with #56 named as owing the measured
/// value, so they are read rather than written here: when the number arrives it
/// lands in the table and both walks follow it.
fn budget(name: &str) -> usize {
    let limits: serde_json::Value = serde_json::from_str(LIMITS).expect("limit-rules.json");
    limits["budgets"][name]["default"]
        .as_u64()
        .unwrap_or_else(|| panic!("the table declares a default for {name}")) as usize
}

/// How deep an object graph may nest before a walk refuses it.
pub fn graph_depth() -> usize {
    static VALUE: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *VALUE.get_or_init(|| budget("graphDepth"))
}

/// How many object visits one walk may spend.
///
/// Depth does not bound the work on a graph: two parents naming one child
/// double the number of paths per level with the depth unchanged. Walking each
/// child once would bound it and would drop the aliases - the same field under
/// two parents has two legitimate names - so the walks keep the aliases and
/// spend against this instead.
pub fn graph_nodes() -> usize {
    static VALUE: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *VALUE.get_or_init(|| budget("graphNodes"))
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
