use beforeshare_core::{path_gate::Gate, stage_binding::Registry, safe_output::{publish,Destination,Cancellation}};
fn write(registry: &Registry, gate: &Gate) {
    let _ = publish(registry, gate, b"unbound bytes".to_vec(), Destination::Automatic, &Cancellation::default());
}
fn main() {}
