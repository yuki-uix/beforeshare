use beforeshare_core::{pdf_metadata::ApprovedRemoval,path_gate::Gate,stage_binding::Registry,safe_output::{Destination,Cancellation}};
fn twice(approved:ApprovedRemoval,registry:&mut Registry,gate:&Gate) {
    let _=approved.publish(registry,gate,Destination::Automatic,&Cancellation::default());
    let _=approved.publish(registry,gate,Destination::Automatic,&Cancellation::default());
}
fn main() {}
