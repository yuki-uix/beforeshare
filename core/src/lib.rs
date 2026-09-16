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

pub mod path_gate;
pub mod pdf;
