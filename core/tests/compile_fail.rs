//! The compile-fail evidence for ADR 0001's first claim.
//!
//! Each file under `tests/compile-fail/` is a program that must NOT build. A
//! test that only checks they fail would pass if they failed for a typo, so the
//! expected error code is checked too - E0451 is "private field", which is the
//! reason that matters. Anything else means the program broke for a reason
//! nobody chose.
use std::process::Command;

#[test]
fn forging_a_resolved_path_does_not_compile() {
    for (file, expected) in [
        ("tests/compile-fail/forge-a-resolved-path.rs", "E0451"),
        ("tests/compile-fail/copy-a-read-path-into-a-write.rs", "E0451"),
    ] {
        // rustc directly: cargo has no per-file build, and an example would be
        // a second place for this to go wrong.
        let status = Command::new("rustc")
            .args([
                file,
                "--edition",
                "2021",
                "--crate-type",
                "bin",
                "-L",
                "target/debug/deps",
                "--extern",
                &format!("beforeshare_core={}", lib_path()),
                "-o",
                // A real, writable path. `-o /dev/null` looked tidier and was
                // wrong: on a successful compile rustc fails trying to write
                // there, so a program that DID build still exited non-zero and
                // the "must not compile" assertion passed. The mutation that
                // makes the fields public caught it - the test went red, but
                // red about a temp directory rather than about a private field.
                out_path(file).to_str().expect("utf-8 path"),
            ])
            .output()
            .expect("rustc runs");
        let produced = out_path(file);
        let built = produced.exists();
        let _ = std::fs::remove_file(&produced);
        assert!(!built, "{file} produced a binary, so it compiled - and it must not");
        assert!(!status.status.success(), "{file} compiled, and it must not");
        let stderr = String::from_utf8_lossy(&status.stderr);
        assert!(
            stderr.contains(expected),
            "{file} failed, but not with {expected} - it must fail because the field is private, not because something else broke:\n{stderr}"
        );
    }
}

/// Somewhere writable for the binary a compile-fail case must never produce.
/// Its existence afterwards is itself the failure signal.
fn out_path(file: &str) -> std::path::PathBuf {
    let stem = std::path::Path::new(file).file_stem().expect("a named file");
    std::env::temp_dir().join(format!("beforeshare-compile-fail-{}", stem.to_string_lossy()))
}

/// The freshly built rlib, so the probe links against this working tree rather
/// than whatever is installed.
fn lib_path() -> String {
    let deps = std::path::Path::new("target/debug/deps");
    let mut newest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    for entry in std::fs::read_dir(deps).expect("cargo has built the library") {
        let path = entry.expect("readable").path();
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        if name.starts_with("libbeforeshare_core-") && name.ends_with(".rlib") {
            let modified = path.metadata().and_then(|m| m.modified()).expect("mtime");
            if newest.as_ref().is_none_or(|(t, _)| modified > *t) {
                newest = Some((modified, path));
            }
        }
    }
    newest.expect("the library is built before this test runs").1.display().to_string()
}
