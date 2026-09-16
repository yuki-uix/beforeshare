//! Emit a canonical inspection result for every §7.1 fixture.
//!
//! The results are committed so the JavaScript validator can hold them to
//! `inspection-result.schema.json` - the same Ajv instance that validates the
//! hand-written examples. A Rust-side assertion that the shape "looks right"
//! would be this code checking itself.
//!
//! Run with: cargo run --example emit-results
use std::path::PathBuf;

use beforeshare_core::pdf;
use beforeshare_core::result::{assemble, InputFacts};

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("the repository root")
        .to_path_buf();
    let files = root.join("fixtures/pdf/files");
    let out = root.join("fixtures/pdf/results");
    std::fs::create_dir_all(&out).expect("the results directory");

    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("fixtures/pdf/manifest.json")).unwrap())
            .expect("the manifest");
    let mut names: Vec<&String> = manifest["fixtures"]
        .as_object()
        .expect("fixtures")
        .keys()
        .filter(|k| !k.starts_with('$'))
        .collect();
    names.sort();

    // Everything that would otherwise vary between runs is fixed: a result that
    // changed because the clock moved could not be compared with a committed
    // one, and the drift check is the point of committing them.
    let mut written = Vec::new();
    for (index, name) in names.iter().enumerate() {
        let bytes = std::fs::read(files.join(name)).expect("a fixture");
        let sha = manifest["fixtures"][*name]["sha256"]
            .as_str()
            .expect("the manifest records a hash")
            .to_string();
        let inspection = pdf::inspect(&bytes);
        let facts = InputFacts {
            path: format!("/fixtures/pdf/files/{name}"),
            media_type: "application/pdf".into(),
            sha256: sha,
            size_bytes: bytes.len() as u64,
        };
        // A ULID-shaped identifier derived from the index, so it is stable and
        // still matches the pattern the schema requires.
        let run_id = format!("01J{:023}", index + 1).replace('0', "0");
        let result = assemble(&inspection, &facts, &run_id, "2026-01-01T00:00:00Z", 0)
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        let text = serde_json::to_string_pretty(&result).expect("serialisable") + "\n";
        let path = out.join(format!("{}.json", name.trim_end_matches(".pdf")));
        std::fs::write(&path, &text).expect("write");
        written.push(path.file_name().unwrap().to_string_lossy().to_string());
        println!("{:<40} {}", name, result["status"].as_str().unwrap_or("?"));
    }

    // The directory is exactly what was written: a fixture removed upstream
    // must not leave its result behind to be validated as if it still existed.
    for entry in std::fs::read_dir(&out).expect("the results directory") {
        let path = entry.expect("readable").path();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if !written.contains(&name) {
            std::fs::remove_file(&path).expect("remove");
            println!("{name:<40} removed: no fixture produces it");
        }
    }
}
