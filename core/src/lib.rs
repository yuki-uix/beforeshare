//! The core §14 draws under the desktop app, the CLI and the MCP server.
//!
//! The rules are not here. They are in `schemas/v1/*.json`, the same files the
//! JavaScript reference implementations read, and they are baked in with
//! `include_str!` rather than copied - a copy is a second thing to keep in step,
//! and the whole point of putting the rules in data was that they outlive the
//! language.
//!
//! What *is* here is the part that could not be expressed before. ADR 0001
//! records three claims this repository held by convention: a path that cannot
//! reach the filesystem without passing the gate, a status that cannot be
//! mistaken for another, and bytes that are the bytes that were hashed. Each
//! had failed once and been fixed by review. A type system catches that class
//! before it is written, which is why this exists.

#![forbid(unsafe_code)]

/// Canonical result contract, including explicit unsupported PDF boundaries.
pub fn schema_version() -> &'static str {
    static VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    VERSION.get_or_init(|| {
        let changelog: serde_json::Value =
            serde_json::from_str(include_str!("../../schemas/v1/CHANGELOG.json"))
                .expect("schema changelog");
        changelog["releases"][0]["version"]
            .as_str()
            .expect("current schema version")
            .to_owned()
    })
}

/// This build's version, so an interface reports the core it is actually running.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub mod identity;
pub mod limits;
pub mod masking;
pub mod path_gate;
pub mod pdf;
pub mod result;
pub mod stage_binding;
