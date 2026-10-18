use beforeshare_core::{
    limits,
    path_gate::{self, Gate, LimitedReadError},
};

#[test]
fn an_oversized_sparse_file_is_refused_before_it_is_read() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("large.pdf");
    let file = std::fs::File::create(&path).unwrap();
    file.set_len(limits::defaults().input_bytes + 1).unwrap();
    let gate = Gate::new(&[dir.path()]).unwrap();
    let resolved = gate.for_read(path.to_str().unwrap()).unwrap();
    assert!(matches!(
        path_gate::read_file_limited(&resolved, limits::defaults().input_bytes),
        Err(LimitedReadError::TooLarge)
    ));
}

#[test]
fn limited_reads_keep_the_authorised_handle_after_path_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("input.pdf");
    std::fs::write(&path, b"original").unwrap();
    let gate = Gate::new(&[dir.path()]).unwrap();
    let resolved = gate.for_read(path.to_str().unwrap()).unwrap();
    let replacement = dir.path().join("replacement.pdf");
    std::fs::write(&replacement, b"replacement").unwrap();
    std::fs::rename(replacement, &path).unwrap();
    assert_eq!(
        path_gate::read_file_limited(&resolved, 8).unwrap(),
        b"original"
    );
    assert_eq!(
        path_gate::read_file_limited(&resolved, 8).unwrap(),
        b"original"
    );
}

#[test]
fn intake_and_deadline_defaults_are_the_canonical_budgets() {
    let rules: serde_json::Value =
        serde_json::from_str(include_str!("../../schemas/v1/limit-rules.json")).unwrap();
    assert_eq!(
        limits::defaults().input_bytes,
        rules["budgets"]["inputBytes"]["default"].as_u64().unwrap()
    );
    assert_eq!(
        limits::defaults().wall_clock_ms,
        rules["budgets"]["wallClockMs"]["default"].as_u64().unwrap()
    );
}
