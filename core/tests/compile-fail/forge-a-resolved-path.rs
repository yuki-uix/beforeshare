//! A path the gate never issued must not compile into a file access.
//!
//! In JavaScript this was a runtime refusal - and the refusal had already been
//! bypassed once, when the brand was a symbol property that object spread
//! copied. Here there is nothing to bypass: the fields are private, so the
//! program does not build.
use beforeshare_core::path_gate::{read_file, Mode, ResolvedPath};

fn main() {
    let forged = ResolvedPath { path: "/etc/passwd".into(), mode: Mode::Read, handle: None };
    let _ = read_file(&forged);
}
