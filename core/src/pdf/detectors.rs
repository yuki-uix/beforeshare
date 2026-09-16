//! One function per detector named in `pdf-detection-rules.json`.
//!
//! Each answers two things the coverage report needs kept apart: what it found,
//! and whether it ran at all. Returning an empty list means "ran, found
//! nothing", which is a claim; `NotRun` means the claim was never made.
use lopdf::{Document, Object};

use super::{location_for, Detected, Location, NotRun};

/// What a detector is given: the parsed document and the bytes behind it.
pub(super) struct Source<'a> {
    pub document: &'a Document,
    pub bytes: &'a [u8],
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

fn text_of(object: &Object) -> Option<String> {
    match object {
        Object::String(bytes, _) => Some(String::from_utf8_lossy(bytes).to_string()),
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
        return Err(NotRun::Failed(
            "the /Info reference does not resolve".into(),
        ));
    };
    let Ok(dict) = info.as_dict() else {
        return Err(NotRun::Failed("/Info is not a dictionary".into()));
    };
    let mut out = Vec::new();
    for (key, category) in FIELDS {
        if let Ok(value) = dict.get(key.as_bytes()) {
            if let Some(text) = text_of(value) {
                if !text.is_empty() {
                    out.push(found(
                        category,
                        "pdf.metadata",
                        Location::field(&location_for(category), key),
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
                    Location::field(&location_for("document_timestamp"), "CreationDate"),
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
            return Err(NotRun::Failed(format!(
                "page {page_number} does not resolve"
            )));
        };
        let Ok(annots) = page.get(b"Annots") else {
            continue;
        };
        let Ok((_, annots)) = doc.dereference(annots) else {
            return Err(NotRun::Failed(format!(
                "/Annots on page {page_number} does not resolve"
            )));
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
                Location::on_page(&location_for("annotation"), page_number, number),
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
fn form_fields(source: &Source) -> Result<Vec<Detected>, NotRun> {
    let doc = source.document;
    let Ok(catalog) = doc.catalog() else {
        return Err(NotRun::Failed("the catalog does not resolve".into()));
    };
    let Ok(acro) = catalog.get(b"AcroForm") else {
        return Ok(Vec::new());
    };
    let Ok((_, acro)) = doc.dereference(acro) else {
        return Err(NotRun::Failed("/AcroForm does not resolve".into()));
    };
    let Ok(acro) = acro.as_dict() else {
        return Err(NotRun::Failed("/AcroForm is not a dictionary".into()));
    };
    let Ok(fields) = acro.get(b"Fields") else {
        return Ok(Vec::new());
    };
    let Ok((_, fields)) = doc.dereference(fields) else {
        return Err(NotRun::Failed("/Fields does not resolve".into()));
    };
    let Ok(fields) = fields.as_array() else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for field in fields {
        let number = match field {
            Object::Reference(id) => id.0,
            _ => 0,
        };
        let Ok((_, field)) = doc.dereference(field) else {
            continue;
        };
        let Ok(dict) = field.as_dict() else { continue };
        if let Some(name) = dict.get(b"T").ok().and_then(text_of) {
            if !name.is_empty() {
                out.push(found(
                    "form_field_name",
                    "pdf.form_fields",
                    Location::object(&location_for("form_field_name"), number),
                    name,
                ));
            }
        }
        if let Some(value) = dict.get(b"V").ok().and_then(text_of) {
            if !value.is_empty() {
                out.push(found(
                    "form_field_value",
                    "pdf.form_fields",
                    Location::object(&location_for("form_field_value"), number),
                    value,
                ));
            }
        }
    }
    Ok(out)
}

/// §7.1 — embedded files.
fn embedded_files(source: &Source) -> Result<Vec<Detected>, NotRun> {
    let doc = source.document;
    let Ok(catalog) = doc.catalog() else {
        return Err(NotRun::Failed("the catalog does not resolve".into()));
    };
    let Ok(names) = catalog.get(b"Names") else {
        return Ok(Vec::new());
    };
    let Ok((_, names)) = doc.dereference(names) else {
        return Err(NotRun::Failed("/Names does not resolve".into()));
    };
    let Ok(names) = names.as_dict() else {
        return Ok(Vec::new());
    };
    let Ok(tree) = names.get(b"EmbeddedFiles") else {
        return Ok(Vec::new());
    };
    let Ok((_, tree)) = doc.dereference(tree) else {
        return Err(NotRun::Failed("/EmbeddedFiles does not resolve".into()));
    };
    let Ok(tree) = tree.as_dict() else {
        return Ok(Vec::new());
    };
    let Ok(pairs) = tree.get(b"Names") else {
        return Ok(Vec::new());
    };
    let Ok((_, pairs)) = doc.dereference(pairs) else {
        return Err(NotRun::Failed("the name tree does not resolve".into()));
    };
    let Ok(pairs) = pairs.as_array() else {
        return Ok(Vec::new());
    };
    // The name tree alternates name, value. The index rather than the name
    // identifies the entry, because a name is not unique and may itself
    // disclose something.
    let mut out = Vec::new();
    for (index, chunk) in pairs.chunks(2).enumerate() {
        let Some(name) = chunk.first().and_then(text_of) else {
            continue;
        };
        out.push(found(
            "embedded_file",
            "pdf.embedded_files",
            Location {
                object_number: Some(index as u32),
                ..Location::of(&location_for("embedded_file"))
            },
            name,
        ));
    }
    Ok(out)
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
                    Location::object(&location_for("document_javascript"), number),
                    value,
                ));
            } else if dict.has(b"JavaScript") {
                out.push(found(
                    "document_javascript",
                    "pdf.actions",
                    Location::object(&location_for("document_javascript"), number),
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
                        Location::object(&location_for("launch_action"), number),
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
                            Location::object(&location_for("local_file_reference"), number),
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
                            Location::object(&location_for(category), number),
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
    let pages = doc.get_pages();
    if pages.is_empty() {
        return Err(NotRun::Skipped("this document has no pages to read"));
    }
    let mut out = Vec::new();
    for (index, (_, page_id)) in pages.iter().enumerate() {
        let page_number = index as u32 + 1;
        let content = doc.get_page_content(*page_id);
        if content.is_empty() {
            continue;
        }
        let Ok(decoded) = lopdf::content::Content::decode(&content) else {
            return Err(NotRun::Failed(format!(
                "the content stream of page {page_number} does not decode"
            )));
        };

        let mut invisible = false;
        // The current transformation, as translation and scale only. A `cm`
        // that rotates or skews is refused below rather than approximated: a
        // silent miss on an apparent redaction is what §17.1 counts as a
        // release blocker, and guessing the geometry is how one happens.
        let mut ctm: Vec<[f64; 4]> = vec![[1.0, 1.0, 0.0, 0.0]]; // sx, sy, tx, ty
                                                                 // Rectangles are kept with the order they were filled in, because a
                                                                 // rectangle painted *before* the text is a background and not a
                                                                 // redaction. The first version collected them all and compared without
                                                                 // order - while carrying a comment saying it did not.
        let mut filled_rects: Vec<(usize, [f64; 4])> = Vec::new();
        let mut drawn: Vec<(usize, String, [f64; 2])> = Vec::new();
        let mut pending_rect: Option<[f64; 4]> = None;
        let mut text_position = [0.0f64, 0.0f64];
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
            let here = *ctm.last().expect("the stack is never empty");
            match op.operator.as_str() {
                "q" => ctm.push(here),
                "Q" => {
                    if ctm.len() > 1 {
                        ctm.pop();
                    }
                }
                "cm" => {
                    if numbers.len() == 6 {
                        let [a, b, c, d, e, f] = [
                            numbers[0], numbers[1], numbers[2], numbers[3], numbers[4], numbers[5],
                        ];
                        if b != 0.0 || c != 0.0 {
                            return Err(NotRun::Failed(format!(
                                "page {page_number} rotates or skews its content, and this detector \
                                 reasons about translation and scale only - reporting nothing here \
                                 would be a silent miss"
                            )));
                        }
                        let top = ctm.last_mut().expect("the stack is never empty");
                        *top = [
                            top[0] * a,
                            top[1] * d,
                            top[2] + e * top[0],
                            top[3] + f * top[1],
                        ];
                    }
                }
                "Tr" => invisible = numbers.first().map(|n| *n == 3.0).unwrap_or(false),
                "Td" | "TD" => {
                    if numbers.len() >= 2 {
                        text_position = [numbers[0], numbers[1]];
                    }
                }
                "Tm" => {
                    if numbers.len() == 6 {
                        text_position = [numbers[4], numbers[5]];
                    }
                }
                "re" => {
                    if numbers.len() == 4 {
                        pending_rect = Some([
                            here[2] + numbers[0] * here[0],
                            here[3] + numbers[1] * here[1],
                            numbers[2] * here[0],
                            numbers[3] * here[1],
                        ]);
                    }
                }
                "f" | "F" | "f*" | "b" | "B" => {
                    if let Some(rect) = pending_rect.take() {
                        filled_rects.push((step, rect));
                    }
                }
                "Tj" | "TJ" => {
                    let text = op
                        .operands
                        .iter()
                        .filter_map(text_of)
                        .collect::<Vec<_>>()
                        .join("");
                    if text.is_empty() {
                        continue;
                    }
                    if invisible {
                        out.push(found(
                            "hidden_text",
                            "pdf.text_layer",
                            Location::on_page(&location_for("hidden_text"), page_number, 0),
                            text,
                        ));
                    } else {
                        let at = [
                            here[2] + text_position[0] * here[0],
                            here[3] + text_position[1] * here[1],
                        ];
                        drawn.push((step, text, at));
                    }
                }
                _ => {}
            }
        }

        // Only a rectangle filled after the text was drawn covers it. One drawn
        // first is a background.
        for (drawn_at, text, [x, y]) in drawn {
            let covered = filled_rects.iter().any(|(filled_at, [rx, ry, w, h])| {
                *filled_at > drawn_at && x >= *rx && x <= rx + w && y >= *ry && y <= ry + h
            });
            if covered {
                out.push(found(
                    "text_under_redaction",
                    "pdf.text_layer",
                    Location::on_page(&location_for("text_under_redaction"), page_number, 0),
                    text,
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
            Location::of(&location_for("encryption_state")),
            "this document declares an /Encrypt dictionary".into(),
        ));
        out.push(found(
            "permission_state",
            "pdf.structure",
            Location::of(&location_for("permission_state")),
            "permissions are carried by the encryption dictionary".into(),
        ));
    }

    for (id, object) in doc.objects.iter() {
        let Ok(dict) = object.as_dict() else { continue };
        if dict.has(b"ByteRange")
            || dict.get(b"Type").ok().and_then(text_of).as_deref() == Some("Sig")
        {
            out.push(found(
                "digital_signature",
                "pdf.structure",
                Location::object(&location_for("digital_signature"), id.0),
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
        out.push(found(
            "incremental_update",
            "pdf.structure",
            Location::of(&location_for("incremental_update")),
            format!("{sections} cross-reference sections: this file was appended to"),
        ));
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
    let mut lines = bytes
        .split(|b| *b == b'\n')
        .map(|line| line.strip_suffix(b"\r").unwrap_or(line));
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
