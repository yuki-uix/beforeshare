//! One function per detector named in `pdf-detection-rules.json`.
//!
//! Each answers two things the coverage report needs kept apart: what it found,
//! and whether it ran at all. Returning an empty list means "ran, found
//! nothing", which is a claim; `NotRun` means the claim was never made.
use std::collections::BTreeSet;

use lopdf::{Document, Object};

use super::{Detected, FailureCode, Location, NotRun, SkipReason, StructureDetail, Trigger};

/// What a detector is given: the parsed document and the bytes behind it.
pub(super) struct Source<'a> {
    pub document: &'a Document,
    pub bytes: &'a [u8],
    /// How many bytes one page's content streams may decompress to, from
    /// `limit-rules.json`'s expansion ratio applied to this input.
    pub decompression_budget: usize,
}

type Detector = fn(&Source) -> Result<Vec<Detected>, NotRun>;

/// The detectors, keyed as the rule table names them.
pub(super) fn all() -> Vec<(&'static str, Detector)> {
    vec![
        ("pdf.metadata", metadata as Detector),
        ("pdf.annotations", annotations as Detector),
        ("pdf.form_fields", form_fields as Detector),
        ("pdf.embedded_files", embedded_files as Detector),
        ("pdf.actions", actions as Detector),
        ("pdf.text_layer", text_layer as Detector),
        ("pdf.structure", structure as Detector),
    ]
}

/// A PDF text string as text.
///
/// Not `from_utf8_lossy`: a PDF text string is either PDFDocEncoded or UTF-16BE
/// behind a byte-order mark, and neither is UTF-8. A name inside a signed
/// document, a form value typed in Chinese, a file name with an accent - all of
/// them came back as replacement characters, and the evidence a person is shown
/// is the value this returns.
fn text_of(object: &Object) -> Option<String> {
    match object {
        Object::String(_, _) => lopdf::decode_text_string(object)
            .ok()
            .or_else(|| match object {
                Object::String(bytes, _) => Some(String::from_utf8_lossy(bytes).to_string()),
                _ => None,
            }),
        Object::Name(bytes) => Some(String::from_utf8_lossy(bytes).to_string()),
        _ => None,
    }
}

fn found(category: &str, detector: &str, location: Location, value: String) -> Detected {
    Detected {
        category: category.to_string(),
        detector: detector.to_string(),
        location,
        value,
        hides_a_removal: false,
    }
}

/// §7.1 — standard document metadata.
///
/// One finding per populated field rather than one for the dictionary, because
/// a person approving removal is approving each value they were shown. The
/// mapping's `locationNote` says so; this is that sentence in code.
fn metadata(source: &Source) -> Result<Vec<Detected>, NotRun> {
    let doc = source.document;
    const FIELDS: [(&str, &str); 7] = [
        ("Author", "document_author"),
        ("Creator", "document_creator"),
        ("Producer", "document_producer"),
        ("Title", "document_title"),
        ("Subject", "document_subject"),
        ("Keywords", "document_keywords"),
        ("ModDate", "document_timestamp"),
    ];
    let Ok(info_ref) = doc.trailer.get(b"Info") else {
        return Ok(Vec::new());
    };
    let Ok((_, info)) = doc.dereference(info_ref) else {
        return Err(NotRun::Failed {
            code: FailureCode::MalformedInput,
            message: "the /Info reference does not resolve".into(),
        });
    };
    let Ok(dict) = info.as_dict() else {
        return Err(NotRun::Failed {
            code: FailureCode::MalformedInput,
            message: "/Info is not a dictionary".into(),
        });
    };
    let mut out = Vec::new();
    for (key, category) in FIELDS {
        if let Ok(value) = dict.get(key.as_bytes()) {
            if let Some(text) = text_of(value) {
                if !text.is_empty() {
                    out.push(found(
                        category,
                        "pdf.metadata",
                        Location::PdfMetadata {
                            field: key.to_string(),
                        },
                        text,
                    ));
                }
            }
        }
    }
    // CreationDate carries the same disclosure as ModDate and maps to the same
    // category; both are reported so a document with only one is not silent.
    if let Ok(value) = dict.get(b"CreationDate") {
        if let Some(text) = text_of(value) {
            if !text.is_empty() {
                out.push(found(
                    "document_timestamp",
                    "pdf.metadata",
                    Location::PdfMetadata {
                        field: "CreationDate".to_string(),
                    },
                    text,
                ));
            }
        }
    }
    Ok(out)
}

/// §7.1 — annotations and comments.
fn annotations(source: &Source) -> Result<Vec<Detected>, NotRun> {
    let doc = source.document;
    let mut out = Vec::new();
    for (index, (_, page_id)) in doc.get_pages().iter().enumerate() {
        let page_number = index as u32 + 1;
        let Ok(page) = doc.get_object(*page_id).and_then(|o| o.as_dict().cloned()) else {
            return Err(NotRun::Failed {
                code: FailureCode::MalformedInput,
                message: format!("page {page_number} does not resolve"),
            });
        };
        let Ok(annots) = page.get(b"Annots") else {
            continue;
        };
        let Ok((_, annots)) = doc.dereference(annots) else {
            return Err(NotRun::Failed {
                code: FailureCode::MalformedInput,
                message: format!("/Annots on page {page_number} does not resolve"),
            });
        };
        let Ok(items) = annots.as_array() else {
            continue;
        };
        for item in items {
            let number = match item {
                Object::Reference(id) => id.0,
                _ => 0,
            };
            let Ok((_, annot)) = doc.dereference(item) else {
                continue;
            };
            let Ok(dict) = annot.as_dict() else { continue };
            // The subtype and any contents are what a reader would see; an
            // annotation with neither is still an annotation and still reported.
            let subtype = dict
                .get(b"Subtype")
                .ok()
                .and_then(text_of)
                .unwrap_or_default();
            let contents = dict
                .get(b"Contents")
                .ok()
                .and_then(text_of)
                .unwrap_or_default();
            let value = if contents.is_empty() {
                format!("/{subtype}")
            } else {
                contents
            };
            out.push(found(
                "annotation",
                "pdf.annotations",
                Location::PdfAnnotation {
                    page: page_number,
                    object_number: Some(number),
                    subtype: (!subtype.is_empty()).then(|| subtype.clone()),
                },
                value,
            ));
        }
    }
    Ok(out)
}

/// §7.1 — form field names and values.
///
/// The name and the value are separate categories from the same location: a
/// field called `applicant_national_id` says what the form collects even when
/// it is empty.
///
/// The field list is a tree. A node with `/Kids` holds its children, and the
/// value may sit on any of them; reading only the top level answered "ran,
/// found nothing" for a form whose fields were grouped, which is a silent miss.
fn form_fields(source: &Source) -> Result<Vec<Detected>, NotRun> {
    let doc = source.document;
    let Ok(catalog) = doc.catalog() else {
        return Err(NotRun::Failed {
            code: FailureCode::MalformedInput,
            message: "the catalog does not resolve".into(),
        });
    };
    let Ok(acro) = catalog.get(b"AcroForm") else {
        return Ok(Vec::new());
    };
    let Ok((_, acro)) = doc.dereference(acro) else {
        return Err(NotRun::Failed {
            code: FailureCode::MalformedInput,
            message: "/AcroForm does not resolve".into(),
        });
    };
    let Ok(acro) = acro.as_dict() else {
        return Err(NotRun::Failed {
            code: FailureCode::MalformedInput,
            message: "/AcroForm is not a dictionary".into(),
        });
    };
    let Ok(fields) = acro.get(b"Fields") else {
        return Ok(Vec::new());
    };
    let Ok((_, fields)) = doc.dereference(fields) else {
        return Err(NotRun::Failed {
            code: FailureCode::MalformedInput,
            message: "/Fields does not resolve".into(),
        });
    };
    let Ok(fields) = fields.as_array() else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    // Objects already walked. A field tree is a graph, not a tree: two parents
    // may name the same child, and following it from both makes the traversal
    // exponential in the depth while the file stays a few hundred bytes. A
    // twenty-four level graph took longer than a minute before this.
    let mut seen = BTreeSet::new();
    for field in fields {
        walk_field(doc, field, "", 0, &mut seen, &mut out)?;
    }
    Ok(out)
}

fn walk_field(
    doc: &Document,
    field: &Object,
    prefix: &str,
    depth: usize,
    seen: &mut BTreeSet<(u32, u16)>,
    out: &mut Vec<Detected>,
) -> Result<(), NotRun> {
    if let Object::Reference(id) = field {
        if !seen.insert(*id) {
            return Ok(());
        }
    }
    if depth > 32 {
        return Err(NotRun::Failed {
            code: FailureCode::MalformedInput,
            message: "the form field tree is nested deeper than this detector will walk".into(),
        });
    }
    let Ok((_, resolved)) = doc.dereference(field) else {
        return Err(NotRun::Failed {
            code: FailureCode::MalformedInput,
            message: "a form field does not resolve".into(),
        });
    };
    let Ok(dict) = resolved.as_dict() else {
        return Ok(());
    };
    // A field's name is its own /T joined to its parents', which is how a
    // grouped form spells `applicant.national_id`.
    let own = dict.get(b"T").ok().and_then(text_of).unwrap_or_default();
    let full = match (prefix.is_empty(), own.is_empty()) {
        (_, true) => prefix.to_string(),
        (true, false) => own.clone(),
        (false, false) => format!("{prefix}.{own}"),
    };

    if !own.is_empty() {
        out.push(found(
            "form_field_name",
            "pdf.form_fields",
            Location::PdfFormField {
                field_name: full.clone(),
                page: None,
            },
            full.clone(),
        ));
    }
    if let Some(value) = dict.get(b"V").ok().and_then(text_of) {
        if !value.is_empty() {
            out.push(found(
                "form_field_value",
                "pdf.form_fields",
                Location::PdfFormField {
                    field_name: full.clone(),
                    page: None,
                },
                value,
            ));
        }
    }
    if let Ok(kids) = dict.get(b"Kids") {
        let Ok((_, kids)) = doc.dereference(kids) else {
            return Err(NotRun::Failed {
                code: FailureCode::MalformedInput,
                message: "a form field's /Kids does not resolve".into(),
            });
        };
        if let Ok(kids) = kids.as_array() {
            for kid in kids {
                walk_field(doc, kid, &full, depth + 1, seen, out)?;
            }
        }
    }
    Ok(())
}

/// §7.1 — embedded files.
///
/// The name tree is a tree: a node holds `/Names` or `/Kids`, and a document
/// with more entries than fit one node uses the second. Reading only `/Names`
/// returned "ran, found nothing" for a document carrying a file - a silent
/// miss, which §17.1 counts as a release blocker rather than a gap.
fn embedded_files(source: &Source) -> Result<Vec<Detected>, NotRun> {
    let doc = source.document;
    let Ok(catalog) = doc.catalog() else {
        return Err(NotRun::Failed {
            code: FailureCode::MalformedInput,
            message: "the catalog does not resolve".into(),
        });
    };
    let Ok(names) = catalog.get(b"Names") else {
        return Ok(Vec::new());
    };
    let Ok((_, names)) = doc.dereference(names) else {
        return Err(NotRun::Failed {
            code: FailureCode::MalformedInput,
            message: "/Names does not resolve".into(),
        });
    };
    let Ok(names) = names.as_dict() else {
        return Ok(Vec::new());
    };
    let Ok(tree) = names.get(b"EmbeddedFiles") else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    let mut index = 0usize;
    let mut seen = BTreeSet::new();
    walk_name_tree(doc, tree, 0, &mut index, &mut seen, &mut out)?;
    Ok(out)
}

fn walk_name_tree(
    doc: &Document,
    node: &Object,
    depth: usize,
    index: &mut usize,
    seen: &mut BTreeSet<(u32, u16)>,
    out: &mut Vec<Detected>,
) -> Result<(), NotRun> {
    if let Object::Reference(id) = node {
        if !seen.insert(*id) {
            return Ok(());
        }
    }
    if depth > 32 {
        return Err(NotRun::Failed {
            code: FailureCode::MalformedInput,
            message: "the embedded-file name tree is nested deeper than this detector will walk"
                .into(),
        });
    }
    let Ok((_, node)) = doc.dereference(node) else {
        return Err(NotRun::Failed {
            code: FailureCode::MalformedInput,
            message: "a name-tree node does not resolve".into(),
        });
    };
    let Ok(dict) = node.as_dict() else {
        return Ok(());
    };
    if let Ok(pairs) = dict.get(b"Names") {
        let Ok((_, pairs)) = doc.dereference(pairs) else {
            return Err(NotRun::Failed {
                code: FailureCode::MalformedInput,
                message: "a name-tree leaf does not resolve".into(),
            });
        };
        if let Ok(pairs) = pairs.as_array() {
            // The leaf alternates name, value. The index rather than the name
            // identifies the entry, because a name is not unique and may itself
            // disclose something.
            for chunk in pairs.chunks(2) {
                let Some(name) = chunk.first().and_then(text_of) else {
                    continue;
                };
                out.push(found(
                    "embedded_file",
                    "pdf.embedded_files",
                    Location::PdfEmbeddedFile {
                        index: *index as u32,
                        name: Some(name.clone()),
                    },
                    name,
                ));
                *index += 1;
            }
        }
    }
    if let Ok(kids) = dict.get(b"Kids") {
        let Ok((_, kids)) = doc.dereference(kids) else {
            return Err(NotRun::Failed {
                code: FailureCode::MalformedInput,
                message: "a name-tree branch does not resolve".into(),
            });
        };
        if let Ok(kids) = kids.as_array() {
            for kid in kids {
                walk_name_tree(doc, kid, depth + 1, index, seen, out)?;
            }
        }
    }
    Ok(())
}

/// §7.1 — document-level JavaScript, launch actions, external and local-file
/// references. One detector, four categories, because all four are reached by
/// walking actions.
///
/// The walk is recursive. An action is almost never at the top of an object:
/// a link's URI sits in `/A << /S /URI /URI (...) >>` inside the annotation,
/// and looking only at top-level dictionaries missed every external reference
/// in the fixture set - the same mistake the parser probe made first, repeated
/// here in the code that matters.
fn actions(source: &Source) -> Result<Vec<Detected>, NotRun> {
    let doc = source.document;
    let mut out = Vec::new();
    for (id, object) in doc.objects.iter() {
        walk_actions(object, id.0, 0, &mut out);
    }
    Ok(out)
}

fn walk_actions(object: &Object, number: u32, depth: usize, out: &mut Vec<Detected>) {
    if depth > 32 {
        return;
    }
    match object {
        Object::Dictionary(dict) => {
            if dict.has(b"JS") {
                let value = dict
                    .get(b"JS")
                    .ok()
                    .and_then(text_of)
                    .unwrap_or_else(|| "(JavaScript in a stream)".into());
                out.push(found(
                    "document_javascript",
                    "pdf.actions",
                    Location::PdfAction {
                        trigger: Trigger::DocumentOpen,
                        page: None,
                        object_number: Some(number),
                    },
                    value,
                ));
            } else if dict.has(b"JavaScript") {
                out.push(found(
                    "document_javascript",
                    "pdf.actions",
                    Location::PdfAction {
                        trigger: Trigger::DocumentOpen,
                        page: None,
                        object_number: Some(number),
                    },
                    "(document-level JavaScript name tree)".into(),
                ));
            }
            match dict.get(b"S").ok().and_then(text_of).as_deref() {
                Some("Launch") => {
                    let target = dict
                        .get(b"F")
                        .ok()
                        .and_then(text_of)
                        .unwrap_or_else(|| "(unnamed target)".into());
                    out.push(found(
                        "launch_action",
                        "pdf.actions",
                        Location::PdfAction {
                            trigger: Trigger::Annotation,
                            page: None,
                            object_number: Some(number),
                        },
                        target,
                    ));
                }
                // /GoToR names a file rather than a page: the path itself is
                // the disclosure. The mapping says this item is reached through
                // /URI, /GoToR or /Launch, and only two of the three were here.
                Some("GoToR") => {
                    if let Some(target) = dict.get(b"F").ok().and_then(text_of) {
                        out.push(found(
                            "local_file_reference",
                            "pdf.actions",
                            Location::PdfAction {
                                trigger: Trigger::Annotation,
                                page: None,
                                object_number: Some(number),
                            },
                            target,
                        ));
                    }
                }
                Some("URI") => {
                    if let Some(uri) = dict.get(b"URI").ok().and_then(text_of) {
                        // A file:// URI names something on this machine, which
                        // is a different disclosure from a link to a server.
                        let category = if uri.starts_with("file:") {
                            "local_file_reference"
                        } else {
                            "external_reference"
                        };
                        out.push(found(
                            category,
                            "pdf.actions",
                            Location::PdfAction {
                                trigger: Trigger::Annotation,
                                page: None,
                                object_number: Some(number),
                            },
                            uri,
                        ));
                    }
                }
                _ => {}
            }
            for (_, value) in dict.iter() {
                walk_actions(value, number, depth + 1, out);
            }
        }
        Object::Array(items) => {
            for item in items {
                walk_actions(item, number, depth + 1, out);
            }
        }
        Object::Stream(stream) => walk_actions(
            &Object::Dictionary(stream.dict.clone()),
            number,
            depth + 1,
            out,
        ),
        _ => {}
    }
}

/// §7.1 — text that is not visually obvious, and text under an apparent
/// redaction.
///
/// Both are facts about the content stream rather than about an object, and
/// both need the operands: `3 Tr` against `0 Tr` is the whole difference in the
/// first, and in the second the text is drawn normally and then covered.
fn text_layer(source: &Source) -> Result<Vec<Detected>, NotRun> {
    let doc = source.document;
    // Encryption is the honest skip: the content streams are there and cannot be
    // read, so a detector that completed would be claiming it looked.
    if doc.trailer.get(b"Encrypt").is_ok() {
        return Err(NotRun::Skipped {
            reason: SkipReason::BlockedByEncryption,
            message: "the content streams are encrypted and were not decrypted".into(),
        });
    }
    // A document with no pages is not a skip. There is no text because there are
    // no pages, and "ran and found nothing" is true - the first version reported
    // a skip here, which claimed a gap that does not exist.
    let pages = doc.get_pages();
    let mut out = Vec::new();
    for (index, (_, page_id)) in pages.iter().enumerate() {
        let page_number = index as u32 + 1;
        // With a limit. `get_page_content` decompresses without one, and
        // `LoadOptions::max_decompressed_size` does not reach page content
        // streams - it bounds what is decoded while the document loads. A
        // compression bomb in a page would exhaust memory before any of this
        // ran. The budget is the expansion ratio from `limit-rules.json` times
        // the input, not a number chosen here.
        let content = match doc.get_page_content_with_limit(*page_id, source.decompression_budget) {
            Ok(bytes) => bytes,
            Err(e) => {
                return Err(NotRun::Failed {
                    code: FailureCode::ResourceLimitExceeded,
                    message: format!(
                        "page {page_number} decompresses past the budget of {} bytes: {e}",
                        source.decompression_budget
                    ),
                })
            }
        };
        if content.is_empty() {
            continue;
        }
        let Ok(decoded) = lopdf::content::Content::decode(&content) else {
            return Err(NotRun::Failed {
                code: FailureCode::MalformedInput,
                message: format!("the content stream of page {page_number} does not decode"),
            });
        };

        // The graphics state, as translation and scale only, with the text
        // render mode in it: `Tr` is part of the graphics state, so `q`/`Q`
        // save and restore it, which the first version did not.
        #[derive(Clone, Copy)]
        struct State {
            sx: f64,
            sy: f64,
            tx: f64,
            ty: f64,
            render_mode: i64,
        }
        let mut stack: Vec<State> = vec![State {
            sx: 1.0,
            sy: 1.0,
            tx: 0.0,
            ty: 0.0,
            render_mode: 0,
        }];

        // Text and line matrices, as translation and scale. `Td` displaces the
        // line matrix and `Tm` replaces it; the first version treated both as
        // absolute coordinates, so a second `Td` in the same text object placed
        // its run at the displacement rather than at the sum.
        #[derive(Clone, Copy)]
        struct TextMatrix {
            sx: f64,
            sy: f64,
            tx: f64,
            ty: f64,
        }
        const IDENTITY: TextMatrix = TextMatrix {
            sx: 1.0,
            sy: 1.0,
            tx: 0.0,
            ty: 0.0,
        };
        let mut line = IDENTITY;
        let mut text = IDENTITY;
        let mut leading = 0.0f64;

        let mut filled_rects: Vec<(usize, [f64; 4])> = Vec::new();
        let mut drawn: Vec<(usize, String, [f64; 2])> = Vec::new();
        // Several `re` may precede one fill: each adds a subpath, and the fill
        // paints all of them. Keeping only the last lost every rectangle but one.
        let mut pending_rects: Vec<[f64; 4]> = Vec::new();
        let mut step = 0usize;

        for op in &decoded.operations {
            step += 1;
            let numbers: Vec<f64> = op
                .operands
                .iter()
                .filter_map(|o| {
                    o.as_f32()
                        .ok()
                        .map(f64::from)
                        .or_else(|| o.as_i64().ok().map(|i| i as f64))
                })
                .collect();
            let here = *stack.last().expect("the stack is never empty");

            // The strings this operator shows, in order. `TJ` takes an array of
            // strings and kerning numbers; `'` and `"` show a string after
            // moving to the next line, and were not handled at all.
            let shown: Vec<String> = match op.operator.as_str() {
                "Tj" | "'" | "\"" => op.operands.iter().filter_map(text_of).collect(),
                "TJ" => op
                    .operands
                    .iter()
                    .flat_map(|o| match o {
                        Object::Array(items) => {
                            items.iter().filter_map(text_of).collect::<Vec<_>>()
                        }
                        other => text_of(other).into_iter().collect(),
                    })
                    .collect(),
                _ => Vec::new(),
            };

            match op.operator.as_str() {
                "q" => stack.push(here),
                "Q" => {
                    if stack.len() > 1 {
                        stack.pop();
                    }
                }
                "cm" => {
                    if numbers.len() == 6 {
                        let (a, b, c, d, e, f) = (
                            numbers[0], numbers[1], numbers[2], numbers[3], numbers[4], numbers[5],
                        );
                        if b != 0.0 || c != 0.0 {
                            return Err(NotRun::Failed { code: FailureCode::MalformedInput, message: format!(
                                "page {page_number} rotates or skews its content, and this detector \
                                 reasons about translation and scale only - reporting nothing here \
                                 would be a silent miss"
                            ) });
                        }
                        let top = stack.last_mut().expect("the stack is never empty");
                        top.tx += e * top.sx;
                        top.ty += f * top.sy;
                        top.sx *= a;
                        top.sy *= d;
                    }
                }
                // 3 is invisible; 7 adds to the clipping path and paints nothing.
                "Tr" => {
                    if let Some(mode) = numbers.first() {
                        stack
                            .last_mut()
                            .expect("the stack is never empty")
                            .render_mode = *mode as i64;
                    }
                }
                "BT" => {
                    line = IDENTITY;
                    text = IDENTITY;
                }
                "TL" => leading = numbers.first().copied().unwrap_or(leading),
                "Td" | "TD" => {
                    if numbers.len() >= 2 {
                        if op.operator == "TD" {
                            leading = -numbers[1];
                        }
                        line = TextMatrix {
                            tx: line.tx + numbers[0] * line.sx,
                            ty: line.ty + numbers[1] * line.sy,
                            ..line
                        };
                        text = line;
                    }
                }
                "Tm" => {
                    if numbers.len() == 6 {
                        if numbers[1] != 0.0 || numbers[2] != 0.0 {
                            return Err(NotRun::Failed {
                                code: FailureCode::MalformedInput,
                                message: format!(
                                "page {page_number} rotates or skews its text, and this detector \
                                 reasons about translation and scale only"
                            ),
                            });
                        }
                        line = TextMatrix {
                            sx: numbers[0],
                            sy: numbers[3],
                            tx: numbers[4],
                            ty: numbers[5],
                        };
                        text = line;
                    }
                }
                "T*" | "'" | "\"" => {
                    line = TextMatrix {
                        ty: line.ty - leading * line.sy,
                        ..line
                    };
                    text = line;
                }
                "re" => {
                    if numbers.len() == 4 {
                        pending_rects.push([
                            here.tx + numbers[0] * here.sx,
                            here.ty + numbers[1] * here.sy,
                            numbers[2] * here.sx,
                            numbers[3] * here.sy,
                        ]);
                    }
                }
                // Every filling operator, including the starred variants that
                // fill with the even-odd rule. Two were missing.
                "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" => {
                    for rect in pending_rects.drain(..) {
                        filled_rects.push((step, rect));
                    }
                }
                "n" | "S" | "s" => {
                    // A path ended without being filled: it covers nothing.
                    pending_rects.clear();
                }
                _ => {}
            }

            for run in shown {
                if run.is_empty() {
                    continue;
                }
                let invisible = matches!(here.render_mode, 3 | 7);
                if invisible {
                    out.push(found(
                        "hidden_text",
                        "pdf.text_layer",
                        Location::PdfTextLayer { page: page_number },
                        run,
                    ));
                } else {
                    let at = [here.tx + text.tx * here.sx, here.ty + text.ty * here.sy];
                    drawn.push((step, run, at));
                }
            }
        }

        // Only a rectangle filled after the text was drawn covers it. One drawn
        // first is a background.
        for (drawn_at, run, [x, y]) in drawn {
            let covered = filled_rects.iter().any(|(filled_at, [rx, ry, w, h])| {
                *filled_at > drawn_at && x >= *rx && x <= rx + w && y >= *ry && y <= ry + h
            });
            if covered {
                out.push(found(
                    "text_under_redaction",
                    "pdf.text_layer",
                    Location::PdfTextLayer { page: page_number },
                    run,
                ));
            }
        }
    }
    Ok(out)
}

/// §7.1 — encryption and permission state, signatures, and incremental updates.
fn structure(source: &Source) -> Result<Vec<Detected>, NotRun> {
    let doc = source.document;
    let mut out = Vec::new();

    if doc.trailer.get(b"Encrypt").is_ok() {
        out.push(found(
            "encryption_state",
            "pdf.structure",
            Location::FileStructure {
                detail: StructureDetail::EncryptionDictionary,
                revision: None,
            },
            "this document declares an /Encrypt dictionary".into(),
        ));
        out.push(found(
            "permission_state",
            "pdf.structure",
            Location::FileStructure {
                detail: StructureDetail::Permissions,
                revision: None,
            },
            "permissions are carried by the encryption dictionary".into(),
        ));
    }

    for object in doc.objects.values() {
        let Ok(dict) = object.as_dict() else { continue };
        if dict.has(b"ByteRange")
            || dict.get(b"Type").ok().and_then(text_of).as_deref() == Some("Sig")
        {
            out.push(found(
                "digital_signature",
                "pdf.structure",
                Location::FileStructure {
                    detail: StructureDetail::SignatureDictionary,
                    revision: None,
                },
                "a signature dictionary is present".into(),
            ));
        }
    }

    // An incremental update appends a second body, cross-reference table and
    // trailer, and the new trailer points back with /Prev. lopdf resolves that
    // chain and does not expose /Prev at all - measured, not assumed - so the
    // object model cannot answer this one. The mapping puts it at
    // `file_structure` rather than on an object, which is the same statement:
    // it is a fact about the file.
    let sections = cross_reference_sections(source.bytes);
    if sections > 1 {
        // The rules table raises this to critical only when a previous revision
        // holds values the current one removes - not for the presence of an
        // update. Deciding that needs the earlier revision, and lopdf resolves
        // the chain and hands back only the current state, so the earlier one is
        // loaded from the bytes: the file up to its first %%EOF is itself a
        // complete PDF.
        let removed = values_the_update_removed(source.bytes);
        let message = if removed.is_empty() {
            format!("{sections} cross-reference sections: this file was appended to")
        } else {
            format!(
                "{sections} cross-reference sections, and an earlier revision still holds {}",
                removed.join(", ")
            )
        };
        let mut finding = found(
            "incremental_update",
            "pdf.structure",
            Location::FileStructure {
                detail: StructureDetail::IncrementalUpdate,
                revision: Some(sections as u32),
            },
            message,
        );
        finding.hides_a_removal = !removed.is_empty();
        out.push(finding);
    }

    Ok(out)
}

/// How many cross-reference sections the file has.
///
/// A `startxref` keyword alone on its line, followed by a line holding only an
/// offset, is the structure; the same word inside a content stream is text. A
/// plain byte search found two "trailers" in a one-revision document whose page
/// text was about PDF internals - and `incremental_update` is the one category
/// the rules table escalates, so a document explaining PDFs would have been
/// escalated.
fn cross_reference_sections(bytes: &[u8]) -> usize {
    // Split on either terminator. A file written with classic Mac line endings
    // has no \n at all, so splitting on it alone made the whole file one line
    // and the sections uncountable - which reads as "not an incremental update".
    let mut lines = bytes
        .split(|b| *b == b'\n' || *b == b'\r')
        .filter(|line| !line.is_empty());
    let mut sections = 0usize;
    while let Some(line) = lines.next() {
        if line.trim_ascii() != b"startxref" {
            continue;
        }
        if let Some(next) = lines.next() {
            let offset = next.trim_ascii();
            if !offset.is_empty() && offset.iter().all(u8::is_ascii_digit) {
                sections += 1;
            }
        }
    }
    sections
}

/// The /Info entries an earlier revision holds that the current one has dropped.
///
/// A reader trusting the newest cross-reference table never sees them, which is
/// the whole reason §7.1 lists incremental updates: the person about to send the
/// file cannot see what they are about to send.
fn values_the_update_removed(bytes: &[u8]) -> Vec<String> {
    let Some(first_eof) = find(bytes, b"%%EOF") else {
        return Vec::new();
    };
    let earlier = &bytes[..first_eof + 5];
    let options = lopdf::LoadOptions {
        strict: false,
        ..Default::default()
    };
    let (Ok(old), Ok(new)) = (
        Document::load_mem_with_options(earlier, options.clone()),
        Document::load_mem_with_options(bytes, options),
    ) else {
        return Vec::new();
    };
    let info_of = |doc: &Document| -> Vec<(String, String)> {
        doc.trailer
            .get(b"Info")
            .ok()
            .and_then(|r| doc.dereference(r).ok())
            .and_then(|(_, o)| o.as_dict().ok().cloned())
            .map(|d| {
                d.iter()
                    .filter_map(|(k, v)| {
                        text_of(v).map(|value| (String::from_utf8_lossy(k).to_string(), value))
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    let current = info_of(&new);
    info_of(&old)
        .into_iter()
        .filter(|(key, value)| !current.iter().any(|(k, v)| k == key && v == value))
        .map(|(key, _)| format!("/{key}"))
        .collect()
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}
