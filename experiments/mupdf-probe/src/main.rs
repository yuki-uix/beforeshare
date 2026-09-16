//! The same questions as the lopdf probe, on the same files, in one process.
//!
//! Variables pinned: identical fixture set, identical question per fixture,
//! identical malformed set. Only the parser differs.
use std::path::{Path, PathBuf};

use mupdf::pdf::{PdfDocument, PdfObject};

fn main() {
    let root = repo_root().join("fixtures/pdf");
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("manifest.json")).expect("manifest"))
            .expect("valid JSON");
    let entries = manifest["fixtures"].as_object().expect("fixtures");

    let mut names: Vec<&String> = entries.keys().filter(|k| !k.starts_with('$')).collect();
    names.sort();

    println!("parser\tfixture\tresult\tnote");
    let mut reached = 0usize;
    let mut failed = 0usize;
    for name in &names {
        let label = entries[*name]["label"].as_str().unwrap_or("?");
        let (mark, note) = reach(&root.join("files").join(name), name);
        if mark == "reached" {
            reached += 1;
        }
        if mark == "FAILED" {
            failed += 1;
        }
        println!("mupdf\t{label}\t{mark}\t{note}\t{name}");
    }

    println!("\n--- malformed inputs ---");
    let malformed = repo_root().join("experiments/malformed");
    let mut broken: Vec<PathBuf> = std::fs::read_dir(&malformed)
        .expect("the malformed set")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .collect();
    broken.sort();
    for path in broken {
        let started = std::time::Instant::now();
        let outcome = match PdfDocument::open(path.to_str().unwrap()) {
            Ok(doc) => match doc.count_objects() {
                Ok(n) => format!("loaded, {n} objects"),
                Err(e) => format!("loaded, object count failed: {e}"),
            },
            Err(e) => format!("refused: {e}"),
        };
        println!(
            "mupdf\t{}\t{outcome}\t{:?}",
            path.file_name().unwrap().to_string_lossy(),
            started.elapsed()
        );
    }

    println!("\nmupdf: {reached} reached, {failed} failed, of {} fixtures", names.len());
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("the repository root")
        .to_path_buf()
}

fn reach(path: &Path, name: &str) -> (&'static str, String) {
    let Ok(doc) = PdfDocument::open(path.to_str().unwrap()) else {
        return ("FAILED", "open refused".into());
    };
    let family = name.split('.').next().unwrap_or("");
    let positive = name.contains(".positive.");

    let found: Option<String> = match family {
        "document-metadata" => doc
            .trailer()
            .ok()
            .and_then(|t| t.get_dict("Info").ok().flatten())
            .map(|info| format!("/Info with {} entries", info.len().unwrap_or(0))),
        "annotations" => find_key(&doc, &["Annots"]),
        "form-fields" => doc
            .has_acro_form()
            .ok()
            .and_then(|yes| yes.then(|| "has_acro_form() == true".to_string())),
        "embedded-file" => doc
            .embedded_files()
            .ok()
            .filter(|f| !f.is_empty())
            .map(|f| format!("embedded_files() -> {} file(s)", f.len())),
        "javascript-and-launch" => find_key(&doc, &["JS", "JavaScript", "Launch"]),
        "external-references" => find_key(&doc, &["URI"]),
        "invisible-text" => unpainted_glyphs(&doc),
        // Text drawn first and covered by a filled shape afterwards. The glyphs
        // are painted normally, so the character flags say nothing; what is
        // needed is the shape drawn over them, and the structured text layer
        // reports text, not paths. Answered honestly as unreachable through
        // this API rather than folded into the question above.
        "text-under-cover" => covered_text(&doc),
        "image-only-page" => find_key(&doc, &["XObject"]),
        // No permissions() fallback: it answers for every document, so the
        // control reported "reached" and the question stopped separating
        // anything. The planted object is /Encrypt, so /Encrypt is the question.
        "encryption-state" => find_key(&doc, &["Encrypt"]),
        "digital-signature" => find_key(&doc, &["ByteRange"]),
        "incremental-update" => {
            let raw = std::fs::read(path).unwrap_or_default();
            let prevs = raw.windows(6).filter(|w| *w == b"/Prev ").count();
            (prevs > 0).then(|| format!("{prevs} /Prev in the file"))
        }
        other => return ("FAILED", format!("no question defined for {other}")),
    };

    match (found, positive) {
        (Some(note), _) => ("reached", note),
        (None, true) => ("absent", "the planted object was not reachable".into()),
        (None, false) => ("absent", "nothing planted, nothing found".into()),
    }
}

/// Walk every object in the cross-reference table, recursing into nested
/// dictionaries and arrays - the same shape as the lopdf probe's walk.
fn find_key(doc: &PdfDocument, keys: &[&str]) -> Option<String> {
    let len = doc.xref_len().ok()?;
    for num in 1..len as i32 {
        let Ok(Some(obj)) = doc.xref_object(num) else {
            continue;
        };
        if let Some(hit) = walk(&obj, keys, 0) {
            return Some(hit);
        }
    }
    // The trailer is not in the xref table's object range.
    doc.trailer().ok().and_then(|t| walk(&t, keys, 0))
}

fn walk(obj: &PdfObject, keys: &[&str], depth: usize) -> Option<String> {
    if depth > 32 {
        return None;
    }
    if obj.is_dict().unwrap_or(false) {
        for k in keys {
            if let Ok(Some(v)) = obj.get_dict(*k) {
                return Some(format!("/{k} = {}", summarise(&v)));
            }
        }
        if let Ok(entries) = obj.dict_iter() {
            for entry in entries.flatten() {
                if let Some(hit) = walk(&entry.1, keys, depth + 1) {
                    return Some(hit);
                }
            }
        }
    }
    if obj.is_array().unwrap_or(false) {
        let n = obj.len().unwrap_or(0);
        for i in 0..n {
            if let Ok(Some(item)) = obj.get_array(i as i32) {
                if let Some(hit) = walk(&item, keys, depth + 1) {
                    return Some(hit);
                }
            }
        }
    }
    None
}

fn summarise(v: &PdfObject) -> String {
    if let Ok(s) = v.as_string() {
        if !s.is_empty() {
            let cut: String = s.chars().take(48).collect();
            return format!("{cut:?}");
        }
    }
    if let Ok(n) = v.as_name() {
        if !n.is_empty() {
            return format!("/{}", String::from_utf8_lossy(&n));
        }
    }
    if v.is_array().unwrap_or(false) {
        return format!("[{} items]", v.len().unwrap_or(0));
    }
    if v.is_dict().unwrap_or(false) {
        return format!("<<{} keys>>", v.len().unwrap_or(0));
    }
    "(value)".into()
}

/// What the structured-text layer reports, which is the half lopdf has to
/// reconstruct from operators.
fn unpainted_glyphs(doc: &PdfDocument) -> Option<String> {
    use mupdf::TextPageFlags;
    let page = doc.load_pdf_page(0).ok()?;
    let tp = page.to_text_page(TextPageFlags::empty()).ok()?;
    // Text alone was too coarse a question - it returned the same two lines for
    // the positive and the control, because MuPDF extracts invisible text too.
    // The discriminator is per-character: a glyph drawn in rendering mode 3 is
    // neither filled nor stroked.
    use mupdf::text_page::TextCharFlags;
    let mut unpainted = String::new();
    let mut painted = String::new();
    for block in tp.blocks() {
        for line in block.lines() {
            for ch in line.chars() {
                let Some(c) = ch.char() else { continue };
                let f = ch.flags();
                if f.contains(TextCharFlags::FILLED) || f.contains(TextCharFlags::STROKED) {
                    painted.push(c);
                } else {
                    unpainted.push(c);
                }
            }
        }
    }
    if !unpainted.trim().is_empty() {
        let cut: String = unpainted.trim().chars().take(56).collect();
        return Some(format!("glyphs neither filled nor stroked: {cut:?}"));
    }
    if painted.trim().is_empty() {
        return None;
    }
    // Everything is painted; the only remaining question this fixture poses is
    // whether text sits under a filled shape, which the text layer alone cannot
    // answer - it reports text, not what is drawn over it.
    None
}

/// Whether the text layer can show that something was drawn over the text.
///
/// It cannot: `fz_stext_page` carries text, images and their quads, not the
/// filled paths painted over them. Reported as unreachable through this API
/// rather than quietly answered with a different question.
fn covered_text(doc: &PdfDocument) -> Option<String> {
    // First the claim the ADR makes about this row: that the raw content stream
    // is reachable from MuPDF too, so the miss is about which API answers the
    // question rather than about what the library can see. Asserted once
    // without being measured; measured here instead.
    if let Ok(len) = doc.xref_len() {
        for num in 1..len as i32 {
            if let Ok(bytes) = doc.xref_stream(num) {
                let text = String::from_utf8_lossy(&bytes);
                if text.contains(" re") && text.contains("Tj") {
                    return Some(format!(
                        "not via the text layer; the raw stream of object {num} has both text and a rectangle ({} bytes)",
                        bytes.len()
                    ));
                }
            }
        }
    }

    use mupdf::TextPageFlags;
    let page = doc.load_pdf_page(0).ok()?;
    let tp = page.to_text_page(TextPageFlags::empty()).ok()?;
    let mut chars = 0usize;
    for block in tp.blocks() {
        for line in block.lines() {
            chars += line.chars().filter_map(|c| c.char()).count();
        }
    }
    let _ = chars;
    None
}
