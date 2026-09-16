//! `{ ...readPath, mode: 'write' }` turned a read authorisation into a write
//! one in JavaScript, because object spread copies symbol keys. The same
//! thought here has nowhere to start: there is no struct literal to spread and
//! no field to change.
use beforeshare_core::path_gate::{Gate, Mode, ResolvedPath};
use std::path::Path;

fn main() {
    let gate = Gate::new(&[Path::new("/tmp/anywhere")]).unwrap();
    let read = gate.for_read("/tmp/anywhere/report.pdf").unwrap();
    let escalated = ResolvedPath { mode: Mode::Write, ..read };
    let _ = escalated;
}
