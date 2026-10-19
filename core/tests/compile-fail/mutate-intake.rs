use beforeshare_core::stage_binding::IntakeRecord;
fn change(record: &IntakeRecord) { record.bytes()[0] = 0; }
fn main() {}
