use beforeshare_core::{pdf_metadata::Plan,path_gate::Gate,stage_binding::Registry,safe_output::{Destination,Cancellation}};
fn unapproved(plan:Plan,registry:&mut Registry,gate:&Gate) {
    let _=plan.publish(registry,gate,Destination::Automatic,&Cancellation::default());
}
fn main() {}
