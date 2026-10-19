//! Synthetic local measurement; no original documents are read or retained.
use beforeshare_core::{
    path_gate::Gate,
    safe_output::{publish, Cancellation, Destination},
    stage_binding::Registry,
};
use serde_json::json;
use std::{num::NonZeroUsize, time::Instant};
fn summary(mut values: Vec<f64>) -> serde_json::Value {
    values.sort_by(f64::total_cmp);
    json!({"median_ms":(values[(values.len()-1)/2]+values[values.len()/2])/2.0,"p95_ms":values[(values.len()*95).div_ceil(100)-1]})
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = tempfile::Builder::new()
        .prefix("beforeshare-sync-")
        .tempdir_in(std::env::current_dir()?)?;
    let input = root.path().join("synthetic.pdf");
    std::fs::write(&input, b"synthetic original")?;
    let gate = Gate::new(&[root.path()])?;
    let samples = 20;
    let mut registry = Registry::new(NonZeroUsize::new(samples * 3).unwrap());
    let mut measurements = vec![];
    for size in [0, 65536, 1048576] {
        let mut elapsed = vec![];
        let mut sync = vec![];
        for sample in 0..samples {
            let id = format!("measure-{size}-{sample}");
            let record = registry.intake(&gate, input.to_str().unwrap(), &id, 1024)?;
            let confirmed = registry.confirm(&gate, &record)?;
            let approval = registry.approve(&confirmed, &["remove_pdf_metadata_field"])?;
            let permit = registry.authorize_sanitize(&gate, &approval)?;
            let prepared = registry.finish_sanitize(&gate, permit, vec![b'x'; size])?;
            let clock = Instant::now();
            let output = publish(
                &registry,
                &gate,
                prepared,
                Destination::Automatic,
                &Cancellation::default(),
            )?;
            elapsed.push(clock.elapsed().as_secs_f64() * 1000.0);
            sync.push(output.sync_time().as_secs_f64() * 1000.0);
            assert!(output.cleanup_complete());
            registry.release(&id);
        }
        measurements.push(json!({"output_bytes":size,"samples":samples,"publication":summary(elapsed),"sync_barriers":summary(sync)}));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "basis":"measured","os":std::env::consts::OS,"arch":std::env::consts::ARCH,
            "profile":if cfg!(debug_assertions) {"debug"} else {"release"},
            "scope":"Synthetic writes on the repository filesystem; includes collisions from earlier samples. Not a power-cut experiment or a worst-case latency bound.",
            "sync_metric":"File fsync, Apple full sync, destination directory fsync and final Apple device flush. The cleanup fsync is included only in publication time.",
            "measurements":measurements
        }))?
    );
    Ok(())
}
