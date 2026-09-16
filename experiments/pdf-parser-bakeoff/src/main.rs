//! What each candidate parser can actually see in the §7.1 fixtures.
//!
//! One question per fixture, taken from what `fixtures/pdf/manifest.json` says
//! was planted: can the parser reach the object carrying the disclosure? Not
//! "does it detect" - there is no detector yet, and a probe that reimplemented
//! one would be measuring the probe.
//!
//! Variables are pinned: the same 24 files, the same questions, one process.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reach {
    /// The parser handed back the object the fixture planted.
    Reached,
    /// The parser loaded the file and the object was not there.
    Absent,
    /// The parser refused the file.
    Failed,
}

impl Reach {
    fn mark(self) -> &'static str {
        match self {
            Reach::Reached => "reached",
            Reach::Absent => "absent",
            Reach::Failed => "FAILED",
        }
    }
}

fn main() {
    let root = fixtures_dir();
    let manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("manifest.json")).expect("the fixture manifest"),
    )
    .expect("valid JSON");
    let entries = manifest["fixtures"]
        .as_object()
        .expect("fixtures is an object");

    let mut rows: BTreeMap<String, (Reach, String)> = BTreeMap::new();
    for (name, meta) in entries {
        if name.starts_with('$') {
            continue;
        }
        let path = root.join("files").join(name);
        let (reach, note) = lopdf_reach(&path, name);
        let label = meta["label"].as_str().unwrap_or("?").to_string();
        rows.insert(format!("{label}\t{name}"), (reach, note));
    }

    println!("parser\tfixture\tresult\tnote");
    for (key, (reach, note)) in &rows {
        let (label, name) = key.split_once('\t').unwrap();
        println!("lopdf\t{label}\t{}\t{note}\t{name}", reach.mark());
    }

    // The fixtures are all well-formed by construction, so they cannot separate
    // a robust parser from a brittle one - and robustness is the only ground on
    // which the heavier candidate could win. These are deliberately broken.
    println!("\n--- malformed inputs (the fixtures cannot express these) ---");
    let malformed = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("experiments/")
        .join("malformed");
    let mut names: Vec<_> = std::fs::read_dir(&malformed)
        .expect("the malformed set")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .collect();
    names.sort();
    for path in names {
        // Both modes, because the interesting question is whether strict turns a
        // silent under-read into a visible refusal. Lenient loading returned Ok
        // with zero objects for a file whose cross-reference offsets are all one
        // byte out - a checker that trusts Ok would report "no findings" about a
        // document it never read, which is the shape §17.1 calls a blocker.
        let mut cells = Vec::new();
        for (label, strict) in [("lenient", false), ("strict", true)] {
            let started = std::time::Instant::now();
            let opts = lopdf::LoadOptions { strict, ..Default::default() };
            let outcome = match lopdf::Document::load_with_options(&path, opts) {
                Ok(doc) => format!("{label}: loaded, {} objects", doc.objects.len()),
                Err(e) => format!("{label}: refused ({e})"),
            };
            cells.push(format!("{outcome} [{:?}]", started.elapsed()));
        }
        println!(
            "lopdf\t{}\t{}",
            path.file_name().unwrap().to_string_lossy(),
            cells.join("\t")
        );
    }

    let failed = rows.values().filter(|(r, _)| *r == Reach::Failed).count();
    let reached = rows.values().filter(|(r, _)| *r == Reach::Reached).count();
    println!("\nlopdf: {reached} reached, {failed} failed, of {} fixtures", rows.len());
}

/// How many entries the `/EmbeddedFiles` name tree under this dictionary holds.
///
/// The tree alternates name, value, so the entry count is half the array's
/// length. A declared but empty tree is what the control carries.
fn embedded_names_len(dict: &lopdf::Dictionary, doc: &lopdf::Document) -> Option<usize> {
    let names = dict.get(b"Names").ok()?;
    let (_, names) = doc.dereference(names).ok()?;
    let names = names.as_dict().ok()?;
    let tree = names.get(b"EmbeddedFiles").ok()?;
    let (_, tree) = doc.dereference(tree).ok()?;
    let tree = tree.as_dict().ok()?;
    let pairs = tree.get(b"Names").ok()?;
    let (_, pairs) = doc.dereference(pairs).ok()?;
    Some(pairs.as_array().ok()?.len() / 2)
}

/// Enough of a value to show the disclosure was actually handed over, not just
/// that a key with that name exists.
fn summarise(v: &lopdf::Object) -> String {
    match v {
        lopdf::Object::String(bytes, _) => {
            let text = String::from_utf8_lossy(bytes);
            let cut: String = text.chars().take(48).collect();
            format!("{cut:?}")
        }
        lopdf::Object::Name(n) => format!("/{}", String::from_utf8_lossy(n)),
        lopdf::Object::Array(a) => format!("[{} items]", a.len()),
        lopdf::Object::Dictionary(d) => format!("<<{} keys>>", d.len()),
        lopdf::Object::Reference(r) => format!("{} 0 R", r.0),
        other => format!("{other:?}").chars().take(32).collect(),
    }
}

fn fixtures_dir() -> PathBuf {
    // From the crate directory up to the repository root.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("the repository root")
        .join("fixtures/pdf")
}

/// The question each fixture poses, answered through lopdf's own API.
fn lopdf_reach(path: &Path, name: &str) -> (Reach, String) {
    use lopdf::Document;

    // strict, because that is what ADR 0002 decides to ship. Measuring the
    // fixtures under lenient loading and the malformed set under both would
    // have reported reach for a configuration the product does not use.
    let options = lopdf::LoadOptions { strict: true, ..Default::default() };
    let doc = match Document::load_with_options(path, options) {
        Ok(d) => d,
        Err(e) => return (Reach::Failed, format!("load: {e}")),
    };

    // Recursive, because the disclosure is rarely at the top of an object:
    // /URI sits under /A, /XObject under /Resources. Looking only at top-level
    // dictionaries reported "the parser cannot reach it" for two fixtures that
    // plainly contained it - a wrong question reads exactly like a finding.
    fn walk(obj: &lopdf::Object, keys: &[&str], depth: usize, found: &mut Option<String>) {
        if depth > 32 || found.is_some() {
            return;
        }
        match obj {
            lopdf::Object::Dictionary(d) => {
                for k in keys {
                    if let Ok(v) = d.get(k.as_bytes()) {
                        *found = Some(format!("/{k} = {}", summarise(v)));
                        return;
                    }
                }
                for (_, v) in d.iter() {
                    walk(v, keys, depth + 1, found);
                }
            }
            lopdf::Object::Array(items) => {
                for v in items {
                    walk(v, keys, depth + 1, found);
                }
            }
            lopdf::Object::Stream(st) => {
                walk(&lopdf::Object::Dictionary(st.dict.clone()), keys, depth + 1, found)
            }
            _ => {}
        }
    }

    let has_in_any_dict = |keys: &[&str]| -> Option<String> {
        let mut found = None;
        for obj in doc.objects.values() {
            walk(obj, keys, 0, &mut found);
            if found.is_some() {
                break;
            }
        }
        found
    };

    let family = name.split('.').next().unwrap_or("");
    let positive = name.contains(".positive.");

    let found: Option<String> = match family {
        "document-metadata" => doc
            .trailer
            .get(b"Info")
            .ok()
            .and_then(|o| doc.dereference(o).ok())
            .and_then(|(_, o)| o.as_dict().ok().cloned())
            .map(|d| format!("/Info with {} fields", d.len())),
        "annotations" => has_in_any_dict(&["Annots"]),
        "form-fields" => doc
            .catalog()
            .ok()
            .and_then(|c| c.get(b"AcroForm").ok())
            .map(|_| "/AcroForm in the catalog".to_string()),
        // Not "/Names exists": that is a generic name-tree container and the
        // control carries one, so the question answered yes for a document with
        // no embedded file in it. The name tree that matters is the one MuPDF's
        // embedded_files() reads, so both probes now ask about the same thing.
        // Not "/Names exists" and not "/EmbeddedFiles exists": the control
        // declares the tree with an empty /Names, so both of those answered yes
        // for a document carrying no file. The question is whether the tree has
        // an entry, which is what MuPDF's embedded_files() reports - so the two
        // probes now ask the same thing.
        // Not "/Names exists" and not "/EmbeddedFiles exists": the control
        // declares the tree with an empty /Names, so both of those answered yes
        // for a document carrying no file. The question is whether the tree
        // holds an entry, which is what MuPDF's embedded_files() reports - so
        // the two probes now ask the same thing of the same document.
        "embedded-file" => doc
            .catalog()
            .ok()
            .and_then(|c| embedded_names_len(c, &doc))
            .filter(|count| *count > 0)
            .map(|count| format!("the name tree holds {count} entries")),
        "javascript-and-launch" => has_in_any_dict(&["JS", "JavaScript", "Launch"]),
        "external-references" => has_in_any_dict(&["URI", "F"]),
        "invisible-text" | "text-under-cover" => {
            // "Does the stream decode" was too weak a question: the positive and
            // the control are the same length, and both answered 134 bytes. What
            // separates them is an operand - `3 Tr` against `0 Tr` - and a
            // filled rectangle drawn over text. So the question is whether the
            // parser hands over operators WITH their operands, which is what a
            // detector needs to tell hidden from visible.
            let mut ops = 0usize;
            let mut invisible_text: Option<String> = None;
            let mut covering_rects = 0usize;
            let mut shown: Vec<String> = Vec::new();
            for (_, id) in &doc.get_pages() {
                let raw = doc.get_page_content(*id);
                let Ok(content) = lopdf::content::Content::decode(&raw) else {
                    continue;
                };
                let mut mode_is_invisible = false;
                for op in &content.operations {
                    ops += 1;
                    match op.operator.as_str() {
                        "Tr" => {
                            mode_is_invisible = matches!(
                                op.operands.first().and_then(|o| o.as_i64().ok()),
                                Some(3)
                            )
                        }
                        "Tj" => {
                            if let Some(lopdf::Object::String(b, _)) = op.operands.first() {
                                let text = String::from_utf8_lossy(b).to_string();
                                shown.push(text.clone());
                                if mode_is_invisible {
                                    invisible_text = Some(text);
                                }
                            }
                        }
                        "re" => covering_rects += 1,
                        _ => {}
                    }
                }
            }
            if ops == 0 {
                None
            } else if let Some(hidden) = invisible_text {
                Some(format!("{ops} operators; text drawn in mode 3: {hidden:?}"))
            } else if covering_rects > 0 && !shown.is_empty() {
                Some(format!(
                    "{ops} operators; {covering_rects} filled rect(s) over text: {:?}",
                    shown[0]
                ))
            } else {
                None
            }
        }
        "image-only-page" => has_in_any_dict(&["XObject"]),
        "encryption-state" => doc
            .trailer
            .get(b"Encrypt")
            .ok()
            .map(|_| "/Encrypt in the trailer".to_string()),
        "digital-signature" => has_in_any_dict(&["ByteRange", "Sig"]),
        "incremental-update" => {
            // An incremental update leaves an earlier cross-reference table that
            // the current one points back to.
            let raw = std::fs::read(path).unwrap_or_default();
            let prevs = raw.windows(6).filter(|w| w == b"/Prev ").count();
            (prevs > 0).then(|| format!("{prevs} /Prev in the file"))
        }
        other => return (Reach::Failed, format!("no question defined for {other}")),
    };

    match (found, positive) {
        (Some(note), _) => (Reach::Reached, note),
        (None, true) => (Reach::Absent, "the planted object was not reachable".into()),
        (None, false) => (Reach::Absent, "nothing planted, nothing found".into()),
    }
}
