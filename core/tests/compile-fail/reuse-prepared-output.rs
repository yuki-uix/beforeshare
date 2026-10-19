use beforeshare_core::{path_gate::Gate, stage_binding::{Registry,ProducedBytes}, safe_output::{publish,Destination,Cancellation}};
fn twice(registry: &Registry, gate: &Gate, prepared: ProducedBytes) {
    let _ = publish(registry, gate, prepared, Destination::Automatic, &Cancellation::default());
    let _ = publish(registry, gate, prepared, Destination::Automatic, &Cancellation::default());
}
fn main() {}
