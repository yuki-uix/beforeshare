use beforeshare_core::safe_output::PublishedOutput;
fn main() {
    let _ = PublishedOutput { path: panic!("forged"), prepared: panic!("forged"), cleanup_complete: true, sync_time: std::time::Duration::ZERO };
}
