//! Experimental, explicitly approved /Info field removal. A rewritten and
//! durably published copy remains unverified until an independent reader exists.
use crate::{
    limits,
    path_gate::{self, Gate},
    pdf,
    safe_output::{self, Cancellation, Destination, PublishedOutput},
    stage_binding::{self, Approval, IntakeRecord, Registry},
    verification::ActionResult,
};
use lopdf::{Document, Object, ObjectId};
use std::{
    collections::{BTreeSet, VecDeque},
    io::{self, Write},
    path::Path,
};

const ACTION: &str = "remove_pdf_metadata_field";
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Field {
    Author,
    Creator,
    Producer,
    Title,
    Subject,
    Keywords,
    ModDate,
    CreationDate,
}
impl Field {
    pub const ALL: &'static [Self] = &[
        Self::Author,
        Self::Creator,
        Self::Producer,
        Self::Title,
        Self::Subject,
        Self::Keywords,
        Self::ModDate,
        Self::CreationDate,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Author => "Author",
            Self::Creator => "Creator",
            Self::Producer => "Producer",
            Self::Title => "Title",
            Self::Subject => "Subject",
            Self::Keywords => "Keywords",
            Self::ModDate => "ModDate",
            Self::CreationDate => "CreationDate",
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    EmptySelection,
    DuplicateField,
    MissingField,
    InvalidBudget,
    MalformedPdf,
    UnsupportedProfile,
    BlockedByEncryption,
    SignatureRequiresReview,
    XmpNotSupported,
    AliasedInfoDictionary,
    ResourceLimitExceeded,
    Cancelled,
    OutputTooLarge,
    WriterFailed,
}
pub enum Error {
    Refused(Refusal),
    Identity(stage_binding::Error),
    Publish(safe_output::Error),
}
impl std::fmt::Debug for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(reason) => write!(f, "metadata removal refused: {reason:?}"),
            Self::Identity(e) => write!(f, "metadata input binding: {e}"),
            Self::Publish(e) => write!(f, "metadata publication: {e}"),
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Debug::fmt(self, f)
    }
}
impl std::error::Error for Error {}
fn refuse(reason: Refusal) -> Error {
    Error::Refused(reason)
}

/// Carries only the selected keys, never evidence values. This warning is
/// required because the canonical class includes changes to file size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SideEffect {
    AltersVisualRendering,
    MakesFutureEditingHarder,
}
impl SideEffect {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AltersVisualRendering => "alters_visual_rendering",
            Self::MakesFutureEditingHarder => "makes_future_editing_harder",
        }
    }
}

/// The exact input record, field selection, budget and rewrite warning reviewed
/// before approval. No mutable access or public constructor exists for approval.
pub struct Plan {
    record: IntakeRecord,
    fields: Vec<Field>,
    output_limit: usize,
    discards_unreferenced_objects: bool,
}
pub struct ApprovedRemoval {
    plan: Plan,
    approval: Approval,
}
pub struct PublishedRemoval {
    output: PublishedOutput,
    fields: Vec<Field>,
    output_limit: u64,
}
macro_rules! opaque_debug { ($($t:ty),+) => { $(impl std::fmt::Debug for $t { fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result { f.debug_struct(stringify!($t)).finish_non_exhaustive() } })+ }; }
opaque_debug!(Plan, ApprovedRemoval, PublishedRemoval);
impl Plan {
    pub fn input(&self) -> &IntakeRecord {
        &self.record
    }
    pub fn fields(&self) -> &[Field] {
        &self.fields
    }
    pub fn side_effects(&self) -> &'static [SideEffect] {
        if self.discards_unreferenced_objects {
            &[
                SideEffect::AltersVisualRendering,
                SideEffect::MakesFutureEditingHarder,
            ]
        } else {
            &[SideEffect::AltersVisualRendering]
        }
    }
    pub fn side_effect_detail(&self) -> &'static str {
        if self.discards_unreferenced_objects {
            "Full rewrite discards pre-existing unreferenced objects and may make future editing harder or change file size; rendering has not been independently compared."
        } else {
            "Full PDF rewrite may change file size; visual rendering and preservation have not been independently compared."
        }
    }
    /// Caller approval covers this owned plan. Adapters must obtain the human
    /// choice; this function does not claim that a user interface was displayed.
    pub fn approve(self, registry: &mut Registry, gate: &Gate) -> Result<ApprovedRemoval, Error> {
        let confirmed = registry
            .confirm(gate, &self.record)
            .map_err(Error::Identity)?;
        let approval = registry
            .approve(&confirmed, &[ACTION])
            .map_err(Error::Identity)?;
        Ok(ApprovedRemoval {
            plan: self,
            approval,
        })
    }
}
impl ApprovedRemoval {
    pub fn fields(&self) -> &[Field] {
        &self.plan.fields
    }
    pub fn publish(
        self,
        registry: &mut Registry,
        gate: &Gate,
        destination: Destination<'_>,
        cancel: &Cancellation,
    ) -> Result<PublishedRemoval, Error> {
        if cancel.is_requested() {
            return Err(refuse(Refusal::Cancelled));
        }
        let permit = registry
            .authorize_sanitize(gate, &self.approval)
            .map_err(Error::Identity)?;
        let mut document = load(permit.bytes())?;
        let info = validate(&document, permit.bytes(), &self.plan.fields)?;
        let dict = document
            .get_object_mut(info)
            .map_err(|_| refuse(Refusal::MalformedPdf))?
            .as_dict_mut()
            .map_err(|_| refuse(Refusal::MalformedPdf))?;
        for field in &self.plan.fields {
            dict.remove(field.as_str().as_bytes());
        }
        if dict.is_empty() {
            document.trailer.remove(b"Info");
        }
        prune(&mut document)?;
        let mut buffer = LimitedBuffer {
            bytes: vec![],
            limit: self.plan.output_limit,
            exceeded: false,
        };
        if document.save_to(&mut buffer).is_err() {
            return Err(refuse(if buffer.exceeded {
                Refusal::OutputTooLarge
            } else {
                Refusal::WriterFailed
            }));
        }
        // Writer-side smoke checks, not independent verification. In particular
        // save_to must not leave dangling references to objects it omitted.
        drop(document);
        let rewritten = load(&buffer.bytes).map_err(|_| refuse(Refusal::WriterFailed))?;
        scan(&rewritten).map_err(|_| refuse(Refusal::WriterFailed))?;
        let still_present = selected_fields_present(&rewritten, &self.plan.fields)
            .map_err(|_| refuse(Refusal::WriterFailed))?;
        if rewritten.get_pages().is_empty() || still_present {
            return Err(refuse(Refusal::WriterFailed));
        }
        drop(rewritten);
        if cancel.is_requested() {
            return Err(refuse(Refusal::Cancelled));
        }
        let prepared = registry
            .finish_sanitize(gate, permit, buffer.bytes)
            .map_err(Error::Identity)?;
        let output = safe_output::publish(registry, gate, prepared, destination, cancel)
            .map_err(Error::Publish)?;
        Ok(PublishedRemoval {
            output,
            fields: self.plan.fields,
            output_limit: self.plan.output_limit as u64,
        })
    }
}
impl PublishedRemoval {
    pub fn path(&self) -> &Path {
        self.output.path()
    }
    pub fn output(&self) -> &PublishedOutput {
        &self.output
    }
    pub fn fields(&self) -> &[Field] {
        &self.fields
    }
    /// Reopen and bind actual disk bytes. Even a clean lopdf readback is only
    /// unable_to_verify, because the writer used the same parsing code.
    pub fn verify(&self, registry: &Registry, gate: &Gate) -> Result<ActionResult, Error> {
        let Some(raw) = self.path().to_str() else {
            return Ok(ActionResult::unavailable("output_could_not_be_reopened"));
        };
        let resolved = match gate.for_read(raw) {
            Ok(value) => value,
            Err(_) => return Ok(ActionResult::unavailable("output_could_not_be_reopened")),
        };
        let bytes = match path_gate::read_file_limited(&resolved, self.output_limit) {
            Ok(value) => value,
            Err(_) => return Ok(ActionResult::unavailable("output_could_not_be_reopened")),
        };
        registry
            .check_verify_allowed(
                self.output.prepared(),
                self.output.prepared().input_sha256(),
                &bytes,
            )
            .map_err(Error::Identity)?;
        let document = match load(&bytes) {
            Ok(value) => value,
            Err(_) => return Ok(ActionResult::unavailable("reader_error")),
        };
        let present = match selected_fields_present(&document, &self.fields) {
            Ok(present) => present,
            Err(_) => return Ok(ActionResult::unavailable("reader_error")),
        };
        Ok(ActionResult::metadata_readback(present))
    }
}

fn selected_fields_present(document: &Document, fields: &[Field]) -> Result<bool, Error> {
    let Ok(info) = document.trailer.get(b"Info") else {
        return Ok(false);
    };
    let dict = resolved_object(document, info)?
        .as_dict()
        .map_err(|_| refuse(Refusal::MalformedPdf))?;
    Ok(fields
        .iter()
        .any(|field| dict.has(field.as_str().as_bytes())))
}

pub fn plan(record: IntakeRecord, fields: &[Field], output_limit: u64) -> Result<Plan, Error> {
    if fields.is_empty() {
        return Err(refuse(Refusal::EmptySelection));
    }
    let unique: BTreeSet<_> = fields.iter().collect();
    if unique.len() != fields.len() {
        return Err(refuse(Refusal::DuplicateField));
    }
    if output_limit == 0 || output_limit > limits::defaults().input_bytes {
        return Err(refuse(Refusal::InvalidBudget));
    }
    let document = load(record.bytes())?;
    validate(&document, record.bytes(), fields)?;
    let retained = reachable(&document)?;
    let discards_unreferenced_objects = document.objects.keys().any(|id| !retained.contains(id));
    Ok(Plan {
        record,
        fields: fields.to_vec(),
        output_limit: output_limit as usize,
        discards_unreferenced_objects,
    })
}
fn load(bytes: &[u8]) -> Result<Document, Error> {
    if bytes.len() as u64 > limits::defaults().input_bytes {
        return Err(refuse(Refusal::ResourceLimitExceeded));
    }
    let options = lopdf::LoadOptions {
        strict: true,
        max_decompressed_size: Some(pdf::decompression_budget(bytes.len())),
        ..Default::default()
    };
    Document::load_mem_with_options(bytes, options).map_err(|e| {
        refuse(match e {
            lopdf::Error::Decompress(lopdf::DecompressError::MemoryLimitExceeded { .. }) => {
                Refusal::ResourceLimitExceeded
            }
            _ => Refusal::MalformedPdf,
        })
    })
}
fn resolved_object<'a>(doc: &'a Document, mut object: &'a Object) -> Result<&'a Object, Error> {
    let mut seen = BTreeSet::new();
    while let Object::Reference(id) = object {
        if !seen.insert(*id) {
            return Err(refuse(Refusal::MalformedPdf));
        }
        if seen.len() > pdf::graph_depth() {
            return Err(refuse(Refusal::ResourceLimitExceeded));
        }
        object = doc
            .objects
            .get(id)
            .ok_or_else(|| refuse(Refusal::MalformedPdf))?;
    }
    Ok(object)
}
/// Scan direct object nesting without recursively following reference cycles.
/// References are checked once against the parsed object table, including orphans.
fn scan(doc: &Document) -> Result<Vec<ObjectId>, Error> {
    if doc.objects.len() > pdf::graph_nodes() || doc.max_id == u32::MAX {
        return Err(refuse(Refusal::ResourceLimitExceeded));
    }
    let mut refs = vec![];
    let mut stack: Vec<_> = doc.objects.values().map(|o| (o, 0)).collect();
    let trailer = Object::Dictionary(doc.trailer.clone());
    stack.push((&trailer, 0));
    let mut visits = 0;
    while let Some((object, depth)) = stack.pop() {
        visits += 1;
        if visits > pdf::graph_nodes() || depth > pdf::graph_depth() {
            return Err(refuse(Refusal::ResourceLimitExceeded));
        }
        match object {
            Object::Reference(id) => {
                if !doc.objects.contains_key(id) {
                    return Err(refuse(Refusal::MalformedPdf));
                }
                refs.push(*id);
            }
            Object::Array(items) => stack.extend(items.iter().map(|o| (o, depth + 1))),
            Object::Dictionary(dict) => scan_dict(doc, dict, depth, &mut stack)?,
            Object::Stream(stream) => scan_dict(doc, &stream.dict, depth, &mut stack)?,
            _ => {}
        }
    }
    Ok(refs)
}
fn scan_dict<'a>(
    doc: &'a Document,
    dict: &'a lopdf::Dictionary,
    depth: usize,
    stack: &mut Vec<(&'a Object, usize)>,
) -> Result<(), Error> {
    if let Ok(value) = dict.get(b"Metadata") {
        if !matches!(resolved_object(doc, value)?, Object::Null) {
            return Err(refuse(Refusal::XmpNotSupported));
        }
    }
    if dict.has(b"ByteRange") || dict.has(b"Perms") {
        return Err(refuse(Refusal::SignatureRequiresReview));
    }
    for key in [b"Type".as_slice(), b"FT"] {
        if let Ok(value) = dict.get(key) {
            if matches!(resolved_object(doc,value)?,Object::Name(name) if name==b"Sig") {
                return Err(refuse(Refusal::SignatureRequiresReview));
            }
        }
    }
    if dict.has(b"Linearized")
        || matches!(dict.get(b"Type").ok().and_then(|o|resolved_object(doc,o).ok()),Some(Object::Name(name)) if name==b"ObjStm" || name==b"XRef" || name==b"Linearized")
    {
        return Err(refuse(Refusal::UnsupportedProfile));
    }
    stack.extend(dict.iter().map(|(_, o)| (o, depth + 1)));
    Ok(())
}
fn validate(doc: &Document, bytes: &[u8], fields: &[Field]) -> Result<ObjectId, Error> {
    if doc.trailer.has(b"Encrypt") {
        return Err(refuse(Refusal::BlockedByEncryption));
    }
    if !matches!(
        doc.reference_table.cross_reference_type,
        lopdf::xref::XrefType::CrossReferenceTable
    ) || doc.trailer.has(b"Prev")
        || doc.trailer.has(b"XRefStm")
        || bytes.windows(5).filter(|b| *b == b"%%EOF").count() != 1
    {
        return Err(refuse(Refusal::UnsupportedProfile));
    }
    let refs = scan(doc)?;
    let info = doc
        .trailer
        .get(b"Info")
        .map_err(|_| refuse(Refusal::MissingField))?
        .as_reference()
        .map_err(|_| refuse(Refusal::UnsupportedProfile))?;
    if refs.iter().filter(|&&id| id == info).count() != 1 {
        return Err(refuse(Refusal::AliasedInfoDictionary));
    }
    // Do not dereference a second Info alias: its target may also be used as
    // another dictionary, making field removal an unapproved nonmetadata edit.
    let Some(Object::Dictionary(dict)) = doc.objects.get(&info) else {
        return Err(refuse(Refusal::UnsupportedProfile));
    };
    for field in fields {
        let value = dict
            .get(field.as_str().as_bytes())
            .map_err(|_| refuse(Refusal::MissingField))?;
        if !matches!(resolved_object(doc, value)?, Object::String(_, _)) {
            return Err(refuse(Refusal::UnsupportedProfile));
        }
    }
    if doc.get_pages().is_empty() {
        return Err(refuse(Refusal::MalformedPdf));
    }
    Ok(info)
}
/// Keep only objects reachable from the current trailer. Removed indirect
/// strings and unused historical objects cannot survive merely as dead objects.
fn reachable(doc: &Document) -> Result<BTreeSet<ObjectId>, Error> {
    let mut seen = BTreeSet::new();
    let mut queue = VecDeque::new();
    let mut stack: Vec<&Object> = doc.trailer.iter().map(|(_, o)| o).collect();
    let mut visits = 0;
    loop {
        while let Some(object) = stack.pop() {
            visits += 1;
            if visits > pdf::graph_nodes() {
                return Err(refuse(Refusal::ResourceLimitExceeded));
            }
            match object {
                Object::Reference(id) => {
                    if seen.insert(*id) {
                        queue.push_back(*id);
                    }
                }
                Object::Array(items) => stack.extend(items),
                Object::Dictionary(dict) => stack.extend(dict.iter().map(|(_, o)| o)),
                Object::Stream(stream) => stack.extend(stream.dict.iter().map(|(_, o)| o)),
                _ => {}
            }
        }
        let Some(id) = queue.pop_front() else { break };
        stack.push(
            doc.objects
                .get(&id)
                .ok_or_else(|| refuse(Refusal::MalformedPdf))?,
        );
    }
    Ok(seen)
}
fn prune(doc: &mut Document) -> Result<(), Error> {
    let retained = reachable(doc)?;
    doc.objects.retain(|id, _| retained.contains(id));
    Ok(())
}
struct LimitedBuffer {
    bytes: Vec<u8>,
    limit: usize,
    exceeded: bool,
}
impl Write for LimitedBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            self.exceeded = true;
            return Err(io::Error::other("metadata output exceeds budget"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests;
