//! Executable contract evidence, using invented repository fixtures only.
use beforeshare_core::{
    limits,
    path_gate::Gate,
    pdf_metadata::{self, Field},
    safe_output::{Cancellation, Destination},
    stage_binding::Registry,
};
use std::{num::NonZeroUsize, path::Path};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = tempfile::tempdir()?;
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures/pdf/files/document-metadata.positive.pdf");
    let input = root.path().join("fixture.pdf");
    std::fs::copy(fixture, &input)?;
    let gate = Gate::new(&[root.path()])?;
    let mut registry = Registry::new(NonZeroUsize::new(1).unwrap());
    let record = registry.intake(
        &gate,
        input.to_str().unwrap(),
        "contract-fixture",
        limits::defaults().input_bytes,
    )?;
    let plan = pdf_metadata::plan(record, &[Field::Author], limits::defaults().input_bytes)?;
    let approved = plan.approve(&mut registry, &gate)?;
    let published = approved.publish(
        &mut registry,
        &gate,
        Destination::Automatic,
        &Cancellation::default(),
    )?;
    let result = published.verify(&registry, &gate)?;
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}
