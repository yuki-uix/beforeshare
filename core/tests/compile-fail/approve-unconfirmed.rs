use beforeshare_core::stage_binding::{Registry, IntakeRecord};
fn approve(registry: &mut Registry, record: &IntakeRecord) {
    let _ = registry.approve(record, &["remove_pdf_metadata_field"]);
}
fn main() {}
