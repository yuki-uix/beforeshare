use beforeshare_core::{
    identity::sha256_hex,
    path_gate::Gate,
    stage_binding::{Error, Registry, Rejection},
};
use std::{collections::BTreeSet, fs, num::NonZeroUsize};

const ACTION: &str = "remove_pdf_metadata_field";
fn registry() -> Registry {
    Registry::new(NonZeroUsize::new(8).unwrap())
}
fn rejected<T: std::fmt::Debug>(result: Result<T, Error>, reason: Rejection) {
    assert!(
        matches!(result, Err(Error::Rejected(actual)) if actual == reason),
        "expected {reason:?}, got {result:?}"
    );
}

#[test]
fn immutable_snapshot_and_hash_describe_the_same_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("input.pdf");
    fs::write(&path, b"original secret").unwrap();
    let gate = Gate::new(&[dir.path()]).unwrap();
    let mut runs = registry();
    let record = runs
        .intake(&gate, path.to_str().unwrap(), "run", 32)
        .unwrap();
    let mut detached = record.bytes().to_vec();
    detached.fill(0);
    fs::write(&path, b"changed").unwrap();
    assert_eq!(record.bytes(), b"original secret");
    assert_eq!(record.sha256(), sha256_hex(b"original secret"));
    assert_eq!(record.size_bytes(), 15);
    assert_eq!(record.run_id(), "run");
    assert_eq!(record.path(), path.canonicalize().unwrap());
    let debug = format!("{record:?}");
    assert!(
        !debug.contains("secret")
            && !debug.contains(record.sha256())
            && !debug.contains("input.pdf")
    );
}

#[test]
fn inspection_rechecks_edits_replacements_and_growth() {
    for change in ["edit", "replace", "grow"] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("input");
        fs::write(&path, b"old").unwrap();
        let gate = Gate::new(&[dir.path()]).unwrap();
        let mut runs = registry();
        let record = runs
            .intake(&gate, path.to_str().unwrap(), "run", 3)
            .unwrap();
        match change {
            "edit" => fs::write(&path, b"new").unwrap(),
            "replace" => {
                let replacement = dir.path().join("replacement");
                fs::write(&replacement, b"new").unwrap();
                fs::rename(replacement, &path).unwrap();
            }
            _ => fs::write(&path, b"longer").unwrap(),
        }
        rejected(
            runs.confirm(&gate, &record),
            Rejection::InputReplacedDuringInspection,
        );
    }
}

#[cfg(unix)]
#[test]
fn retargeted_alias_is_rejected_even_with_identical_bytes() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first");
    let second = dir.path().join("second");
    let alias = dir.path().join("alias");
    fs::write(&first, b"same").unwrap();
    fs::write(&second, b"same").unwrap();
    symlink(&first, &alias).unwrap();
    let gate = Gate::new(&[dir.path()]).unwrap();
    let mut runs = registry();
    let record = runs
        .intake(&gate, alias.to_str().unwrap(), "run", 10)
        .unwrap();
    fs::remove_file(&alias).unwrap();
    symlink(&second, &alias).unwrap();
    rejected(runs.confirm(&gate, &record), Rejection::NotThePathInspected);
}

#[test]
fn stale_approval_is_refused_before_transform_and_before_output() {
    for change_before_transform in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("input");
        fs::write(&path, b"old").unwrap();
        let gate = Gate::new(&[dir.path()]).unwrap();
        let mut runs = registry();
        let record = runs
            .intake(&gate, path.to_str().unwrap(), "run", 10)
            .unwrap();
        let confirmed = runs.confirm(&gate, &record).unwrap();
        let approval = runs.approve(&confirmed, &[ACTION]).unwrap();
        if change_before_transform {
            fs::write(&path, b"new").unwrap();
            rejected(
                runs.authorize_sanitize(&gate, &approval),
                Rejection::InputChangedSinceInspection,
            );
        } else {
            let permit = runs.authorize_sanitize(&gate, &approval).unwrap();
            fs::write(&path, b"new").unwrap();
            rejected(
                runs.finish_sanitize(&gate, permit, b"output".to_vec()),
                Rejection::InputChangedSinceInspection,
            );
        }
    }
}

#[test]
fn foreign_registry_with_matching_id_and_bytes_cannot_accept_tokens() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("input");
    fs::write(&path, b"same").unwrap();
    let gate = Gate::new(&[dir.path()]).unwrap();
    let mut first = registry();
    let mut second = registry();
    let record = first
        .intake(&gate, path.to_str().unwrap(), "run", 10)
        .unwrap();
    let _other = second
        .intake(&gate, path.to_str().unwrap(), "run", 10)
        .unwrap();
    rejected(second.confirm(&gate, &record), Rejection::UnknownRun);
    let confirmed = first.confirm(&gate, &record).unwrap();
    rejected(second.approve(&confirmed, &[ACTION]), Rejection::UnknownRun);
    let approval = first.approve(&confirmed, &[ACTION]).unwrap();
    rejected(
        second.authorize_sanitize(&gate, &approval),
        Rejection::UnknownRun,
    );
    let permit = first.authorize_sanitize(&gate, &approval).unwrap();
    let produced = first
        .finish_sanitize(&gate, permit, b"out".to_vec())
        .unwrap();
    rejected(
        second.check_verify_allowed(&produced, record.sha256(), b"out"),
        Rejection::UnknownRun,
    );
}

#[test]
fn released_ids_remain_spent_and_tokens_are_invalidated() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("input");
    fs::write(&path, b"same").unwrap();
    let gate = Gate::new(&[dir.path()]).unwrap();
    let mut runs = Registry::new(NonZeroUsize::new(1).unwrap());
    let record = runs
        .intake(&gate, path.to_str().unwrap(), "run", 10)
        .unwrap();
    rejected(
        runs.intake(&gate, path.to_str().unwrap(), "run", 10),
        Rejection::DuplicateRunId,
    );
    let confirmed = runs.confirm(&gate, &record).unwrap();
    let approval = runs.approve(&confirmed, &[ACTION]).unwrap();
    assert!(runs.release("run"));
    assert!(!runs.release("run"));
    rejected(
        runs.authorize_sanitize(&gate, &approval),
        Rejection::UnknownRun,
    );
    rejected(
        runs.intake(&gate, path.to_str().unwrap(), "run", 10),
        Rejection::DuplicateRunId,
    );
    assert!(matches!(
        runs.intake(&gate, path.to_str().unwrap(), "next", 10),
        Err(Error::CapacityExhausted)
    ));
}

#[test]
fn stage_permits_are_single_use_and_output_identity_is_checked() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("input");
    fs::write(&path, b"same").unwrap();
    let gate = Gate::new(&[dir.path()]).unwrap();
    let mut runs = registry();
    let record = runs
        .intake(&gate, path.to_str().unwrap(), "run", 10)
        .unwrap();
    let confirmed = runs.confirm(&gate, &record).unwrap();
    rejected(runs.confirm(&gate, &record), Rejection::StageOutOfOrder);
    for actions in [&[][..], &["invented_action"][..]] {
        assert!(matches!(
            runs.approve(&confirmed, actions),
            Err(Error::InvalidArgument(_))
        ));
    }
    let approval = runs.approve(&confirmed, &[ACTION]).unwrap();
    assert_eq!(approval.actions(), &[ACTION]);
    assert_eq!(approval.input_sha256(), record.sha256());
    assert_eq!(approval.run_id(), record.run_id());
    rejected(
        runs.approve(&confirmed, &[ACTION]),
        Rejection::StageOutOfOrder,
    );
    let permit = runs.authorize_sanitize(&gate, &approval).unwrap();
    assert_eq!(permit.bytes(), record.bytes());
    assert_eq!(permit.input_sha256(), record.sha256());
    assert_eq!(permit.actions(), &[ACTION]);
    rejected(
        runs.authorize_sanitize(&gate, &approval),
        Rejection::StageOutOfOrder,
    );
    let produced = runs
        .finish_sanitize(&gate, permit, b"out".to_vec())
        .unwrap();
    assert_eq!(produced.sha256(), sha256_hex(b"out"));
    assert_eq!(produced.bytes(), b"out");
    assert_eq!(produced.input_sha256(), record.sha256());
    assert_eq!(produced.run_id(), record.run_id());
    runs.check_verify_allowed(&produced, record.sha256(), b"out")
        .unwrap();
    rejected(
        runs.check_verify_allowed(&produced, record.sha256(), b"other"),
        Rejection::OutputNotFromThisRun,
    );
    rejected(
        runs.check_verify_allowed(&produced, &sha256_hex(b"different input"), b"out"),
        Rejection::InputChangedSinceInspection,
    );
    runs.release("run");
    rejected(
        runs.check_verify_allowed(&produced, record.sha256(), b"out"),
        Rejection::UnknownRun,
    );
}

#[test]
fn invalid_or_failed_intake_does_not_spend_the_identifier() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("input");
    fs::write(&path, b"same").unwrap();
    let gate = Gate::new(&[dir.path()]).unwrap();
    let mut runs = Registry::new(NonZeroUsize::new(1).unwrap());
    for limit in [0, u64::MAX] {
        assert!(matches!(
            runs.intake(&gate, path.to_str().unwrap(), "run", limit),
            Err(Error::InvalidArgument(_))
        ));
    }
    assert!(matches!(
        runs.intake(&gate, path.to_str().unwrap(), "", 10),
        Err(Error::InvalidArgument(_))
    ));
    assert!(runs
        .intake(&gate, path.to_str().unwrap(), "run", 3)
        .is_err());
    let record = runs
        .intake(&gate, path.to_str().unwrap(), "run", 10)
        .unwrap();
    // The binding compares snapshots; it cannot detect a change that was undone.
    fs::write(&path, b"temporary").unwrap();
    fs::write(&path, b"same").unwrap();
    runs.confirm(&gate, &record).unwrap();
}

#[test]
fn rejection_enum_matches_the_unchanged_contract_in_both_directions() {
    let table: serde_json::Value =
        serde_json::from_str(include_str!("../../schemas/v1/identity-rules.json")).unwrap();
    let canonical: BTreeSet<_> = table["rejectionReasons"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    let rust: BTreeSet<_> = Rejection::ALL
        .iter()
        .map(|reason| reason.as_str())
        .collect();
    assert_eq!(rust, canonical);
    assert_eq!(rust.len(), Rejection::ALL.len());
}
