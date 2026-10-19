use beforeshare_core::{stage_binding::{Registry, SanitizeInput}, path_gate::Gate};
fn reuse(registry: &mut Registry, gate: &Gate, permit: SanitizeInput) {
    let _ = registry.finish_sanitize(gate, permit, vec![]);
    let _ = registry.finish_sanitize(gate, permit, vec![]);
}
fn main() {}
