use super::*;
use std::{
    num::NonZeroUsize,
    os::unix::fs::{symlink, MetadataExt, PermissionsExt},
};

struct Fixture {
    dir: tempfile::TempDir,
    gate: Gate,
    registry: Registry,
    input: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("report.pdf");
        std::fs::write(&input, b"original").unwrap();
        let gate = Gate::new(&[dir.path()]).unwrap();
        Self {
            dir,
            gate,
            registry: Registry::new(NonZeroUsize::new(200).unwrap()),
            input,
        }
    }
    fn prepare(&mut self, id: &str, bytes: Vec<u8>) -> ProducedBytes {
        let record = self
            .registry
            .intake(&self.gate, self.input.to_str().unwrap(), id, 32)
            .unwrap();
        let confirmed = self.registry.confirm(&self.gate, &record).unwrap();
        let approval = self
            .registry
            .approve(&confirmed, &["remove_pdf_metadata_field"])
            .unwrap();
        let permit = self
            .registry
            .authorize_sanitize(&self.gate, &approval)
            .unwrap();
        self.registry
            .finish_sanitize(&self.gate, permit, bytes)
            .unwrap()
    }
    fn destination(&self) -> PathBuf {
        self.dir
            .path()
            .canonicalize()
            .unwrap()
            .join("report (sanitized).pdf")
    }
    fn assert_original(&self) {
        assert_eq!(std::fs::read(&self.input).unwrap(), b"original");
    }
    fn assert_no_temp(&self) {
        assert!(std::fs::read_dir(self.dir.path()).unwrap().all(|e| !e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(marker())));
    }
}

#[test]
fn independent_copy_is_complete_private_and_bound_to_its_run() {
    let mut f = Fixture::new();
    let bytes = f.prepare("run", b"prepared output".to_vec());
    let result = publish(
        &f.registry,
        &f.gate,
        bytes,
        Destination::Automatic,
        &Cancellation::default(),
    )
    .unwrap();
    assert_eq!(result.path(), f.destination());
    assert_eq!(std::fs::read(result.path()).unwrap(), b"prepared output");
    let metadata = std::fs::metadata(result.path()).unwrap();
    assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
    assert_ne!(metadata.ino(), std::fs::metadata(&f.input).unwrap().ino());
    assert_eq!(metadata.nlink(), 1);
    assert!(result.cleanup_complete());
    f.registry
        .check_verify_allowed(
            result.prepared(),
            result.prepared().input_sha256(),
            b"prepared output",
        )
        .unwrap();
    assert!(!format!("{result:?}").contains("prepared output"));
    f.assert_original();
    f.assert_no_temp();
}

#[test]
fn naming_matches_last_dot_and_all_canonical_actions_share_the_writer() {
    for (name, expected) in [
        ("report.pdf", "report (sanitized).pdf"),
        ("report", "report (sanitized)"),
        (".bashrc", ".bashrc (sanitized)"),
        ("archive.tar.gz", "archive.tar (sanitized).gz"),
        ("文档.pdf", "文档 (sanitized).pdf"),
    ] {
        assert_eq!(candidate_name(name, 1), expected);
    }
    assert_eq!(candidate_name("report.pdf", 2), "report (sanitized) 2.pdf");
    let enums: serde_json::Value =
        serde_json::from_str(include_str!("../../../schemas/v1/enums.schema.json")).unwrap();
    let mut f = Fixture::new();
    for (i, action) in enums["$defs"]["remediationAction"]["enum"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let id = format!("action-{i}");
        let record = f
            .registry
            .intake(&f.gate, f.input.to_str().unwrap(), &id, 32)
            .unwrap();
        let confirmed = f.registry.confirm(&f.gate, &record).unwrap();
        let approval = f
            .registry
            .approve(&confirmed, &[action.as_str().unwrap()])
            .unwrap();
        let permit = f.registry.authorize_sanitize(&f.gate, &approval).unwrap();
        let bytes = f
            .registry
            .finish_sanitize(
                &f.gate,
                permit,
                action.as_str().unwrap().as_bytes().to_vec(),
            )
            .unwrap();
        let output = publish(
            &f.registry,
            &f.gate,
            bytes,
            Destination::Automatic,
            &Cancellation::default(),
        )
        .unwrap();
        assert_eq!(
            std::fs::read(output.path()).unwrap(),
            action.as_str().unwrap().as_bytes()
        );
        f.assert_original();
    }
    f.assert_no_temp();
}

#[test]
fn explicit_occupied_input_aliases_and_links_are_never_overwritten() {
    for variant in ["occupied", "input", "hardlink", "symlink", "dangling"] {
        let mut f = Fixture::new();
        let path = match variant {
            "input" => f.input.clone(),
            _ => f.dir.path().join("explicit.pdf"),
        };
        match variant {
            "occupied" => std::fs::write(&path, b"other").unwrap(),
            "hardlink" => std::fs::hard_link(&f.input, &path).unwrap(),
            "symlink" => symlink(&f.input, &path).unwrap(),
            "dangling" => symlink(f.dir.path().join("missing.pdf"), &path).unwrap(),
            _ => {}
        }
        let bytes = f.prepare("run", b"new".to_vec());
        let result = publish(
            &f.registry,
            &f.gate,
            bytes,
            Destination::Explicit(path.to_str().unwrap()),
            &Cancellation::default(),
        )
        .unwrap_err();
        assert!(
            matches!(result.code(), "destination_exists" | "output_is_input"),
            "{variant}: {result}"
        );
        assert!(result.published_path().is_none());
        if variant == "occupied" {
            assert_eq!(std::fs::read(&path).unwrap(), b"other");
        }
        assert!(!f.dir.path().join("missing.pdf").exists());
        f.assert_original();
        f.assert_no_temp();
    }
}

#[test]
fn occupied_temporary_names_and_exhausted_names_are_reported() {
    let mut f = Fixture::new();
    let explicit = f.dir.path().join("explicit.pdf");
    let temp = f.dir.path().join("explicit.pdf.part");
    std::fs::write(&temp, b"another run").unwrap();
    let bytes = f.prepare("busy", b"output".to_vec());
    let e = publish(
        &f.registry,
        &f.gate,
        bytes,
        Destination::Explicit(explicit.to_str().unwrap()),
        &Cancellation::default(),
    )
    .unwrap_err();
    assert_eq!(e.code(), "temp_name_taken");
    assert_eq!(std::fs::read(&temp).unwrap(), b"another run");
    std::fs::remove_file(temp).unwrap();
    for n in 1..=naming().max_attempts {
        std::fs::write(f.dir.path().join(candidate_name("report.pdf", n)), b"other").unwrap();
    }
    let bytes = f.prepare("full", b"output".to_vec());
    let e = publish(
        &f.registry,
        &f.gate,
        bytes,
        Destination::Automatic,
        &Cancellation::default(),
    )
    .unwrap_err();
    assert_eq!(e.code(), "no_free_name");
    f.assert_original();
    f.assert_no_temp();
}

#[test]
fn concurrent_publications_get_different_names_and_keep_complete_bytes() {
    let mut f = Fixture::new();
    let first = f.prepare("first", vec![b'a'; 128 * 1024]);
    let second = f.prepare("second", vec![b'b'; 128 * 1024]);
    let barrier = std::sync::Barrier::new(2);
    let (a, b) = std::thread::scope(|scope| {
        let a = scope.spawn(|| {
            barrier.wait();
            publish(
                &f.registry,
                &f.gate,
                first,
                Destination::Automatic,
                &Cancellation::default(),
            )
            .unwrap()
        });
        let b = scope.spawn(|| {
            barrier.wait();
            publish(
                &f.registry,
                &f.gate,
                second,
                Destination::Automatic,
                &Cancellation::default(),
            )
            .unwrap()
        });
        (a.join().unwrap(), b.join().unwrap())
    });
    assert_ne!(a.path(), b.path());
    assert_eq!(std::fs::read(a.path()).unwrap(), vec![b'a'; 128 * 1024]);
    assert_eq!(std::fs::read(b.path()).unwrap(), vec![b'b'; 128 * 1024]);
    f.assert_original();
    f.assert_no_temp();
}

#[test]
fn stale_released_and_foreign_prepared_outputs_cannot_be_published() {
    for variant in ["stale", "released", "foreign"] {
        let mut f = Fixture::new();
        let bytes = f.prepare("run", b"output".to_vec());
        if variant == "stale" {
            std::fs::write(&f.input, b"changed").unwrap();
        }
        if variant == "released" {
            f.registry.release("run");
        }
        let other = Registry::new(NonZeroUsize::new(1).unwrap());
        let registry = if variant == "foreign" {
            &other
        } else {
            &f.registry
        };
        let e = publish(
            registry,
            &f.gate,
            bytes,
            Destination::Automatic,
            &Cancellation::default(),
        )
        .unwrap_err();
        assert_eq!(
            e.code(),
            if variant == "stale" {
                "input_changed_since_inspection"
            } else {
                "unknown_run"
            }
        );
        assert!(!f.destination().exists());
        f.assert_no_temp();
    }
}

struct Trace {
    events: Vec<Phase>,
    fail: Option<Phase>,
    destination: PathBuf,
}
impl Operations for Trace {
    fn write(&mut self, file: &mut File, bytes: &[u8]) -> io::Result<()> {
        self.events.push(Phase::Write);
        assert!(!self.destination.exists());
        if self.fail == Some(Phase::Write) {
            file.write_all(&bytes[..bytes.len().min(3)])?;
            return Err(rustix::io::Errno::NOSPC.into());
        }
        file.write_all(bytes)
    }
    fn sync_file(&mut self, file: &File) -> io::Result<()> {
        self.events.push(Phase::FileSync);
        assert!(!self.destination.exists());
        if self.fail == Some(Phase::FileSync) {
            return Err(rustix::io::Errno::NOSPC.into());
        }
        System.sync_file(file)
    }
    fn sync_directory(&mut self, directory: &OutputDirectory) -> io::Result<()> {
        self.events.push(Phase::DirectorySync);
        assert_eq!(
            std::fs::read(&self.destination).unwrap(),
            b"complete output"
        );
        if self.fail == Some(Phase::DirectorySync) {
            return Err(rustix::io::Errno::IO.into());
        }
        System.sync_directory(directory)
    }
    fn sync_drive(&mut self, file: &File) -> io::Result<()> {
        self.events.push(Phase::DriveSync);
        if self.fail == Some(Phase::DriveSync) {
            return Err(rustix::io::Errno::IO.into());
        }
        System.sync_drive(file)
    }
}

#[test]
fn sync_order_and_failures_distinguish_unpublished_from_durability_unknown() {
    for failure in [
        None,
        Some(Phase::Write),
        Some(Phase::FileSync),
        Some(Phase::DirectorySync),
        Some(Phase::DriveSync),
    ] {
        let mut f = Fixture::new();
        let bytes = f.prepare("run", b"complete output".to_vec());
        let mut ops = Trace {
            events: vec![],
            fail: failure,
            destination: f.destination(),
        };
        let result = publish_with(
            &f.registry,
            &f.gate,
            bytes,
            Destination::Automatic,
            &Cancellation::default(),
            &mut ops,
        );
        match failure {
            None => {
                assert!(result.is_ok(), "{result:?}");
                assert_eq!(
                    ops.events,
                    vec![
                        Phase::Write,
                        Phase::FileSync,
                        Phase::DirectorySync,
                        Phase::DriveSync
                    ]
                );
            }
            Some(phase) => {
                let e = result.unwrap_err();
                assert_eq!(e.phase(), phase);
                let published = matches!(phase, Phase::DirectorySync | Phase::DriveSync);
                assert_eq!(e.published_path().is_some(), published);
                assert_eq!(f.destination().exists(), published);
                if published {
                    assert_eq!(e.published_path(), Some(f.destination().as_path()));
                    assert_eq!(std::fs::read(f.destination()).unwrap(), b"complete output");
                }
                assert_eq!(
                    e.code(),
                    if matches!(phase, Phase::Write | Phase::FileSync) {
                        "disk_full"
                    } else {
                        "write_failed"
                    }
                );
            }
        }
        f.assert_original();
        f.assert_no_temp();
    }
}

struct Hook<F>(F);
impl<F: FnMut(Phase) -> io::Result<()>> Operations for Hook<F> {
    fn at(&mut self, phase: Phase) -> io::Result<()> {
        (self.0)(phase)
    }
}

#[test]
fn cancellation_cleans_up_before_link_and_finishes_durability_after_link() {
    for phase in [
        Phase::Write,
        Phase::FileSync,
        Phase::Publish,
        Phase::DirectorySync,
    ] {
        let mut f = Fixture::new();
        let bytes = f.prepare("run", vec![b'x'; 128 * 1024]);
        let cancel = Cancellation::default();
        let mut ops = Hook(|at| {
            if at == phase {
                cancel.cancel();
            }
            Ok(())
        });
        let result = publish_with(
            &f.registry,
            &f.gate,
            bytes,
            Destination::Automatic,
            &cancel,
            &mut ops,
        );
        if phase == Phase::DirectorySync {
            assert!(result.is_ok());
        } else {
            assert_eq!(result.unwrap_err().code(), "cancelled");
            assert!(!f.destination().exists());
        }
        f.assert_original();
        f.assert_no_temp();
    }
}

#[test]
fn publishing_race_never_replaces_the_new_occupant() {
    for explicit in [false, true] {
        let mut f = Fixture::new();
        let path = f.destination();
        let bytes = f.prepare("run", b"prepared".to_vec());
        let mut planted = false;
        let mut ops = Hook(|phase| {
            if phase == Phase::Publish && !planted {
                std::fs::write(&path, b"other run")?;
                planted = true;
            }
            Ok(())
        });
        let selection = if explicit {
            Destination::Explicit(path.to_str().unwrap())
        } else {
            Destination::Automatic
        };
        let result = publish_with(
            &f.registry,
            &f.gate,
            bytes,
            selection,
            &Cancellation::default(),
            &mut ops,
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"other run");
        if explicit {
            assert_eq!(result.unwrap_err().code(), "destination_exists");
        } else {
            let published = result.unwrap();
            assert_ne!(published.path(), path);
            assert_eq!(std::fs::read(published.path()).unwrap(), b"prepared");
        }
        f.assert_original();
        f.assert_no_temp();
    }
}

#[test]
fn fixed_directory_handle_defeats_parent_and_temporary_directory_swaps() {
    let mut f = Fixture::new();
    let directory = f.dir.path().join("export");
    std::fs::create_dir(&directory).unwrap();
    let moved = f.dir.path().join("held");
    let outside = tempfile::tempdir().unwrap();
    let selected = directory.join("copy.pdf");
    let bytes = f.prepare("run", b"prepared".to_vec());
    let mut ops = Hook(|phase| {
        if phase == Phase::Write {
            std::fs::rename(&directory, &moved)?;
            symlink(outside.path(), &directory)?;
            let temp = moved.join("copy.pdf.part");
            std::fs::rename(&temp, moved.join("held.part"))?;
            symlink(outside.path(), &temp)?;
        }
        Ok(())
    });
    let result = publish_with(
        &f.registry,
        &f.gate,
        bytes,
        Destination::Explicit(selected.to_str().unwrap()),
        &Cancellation::default(),
        &mut ops,
    )
    .unwrap_err();
    assert_eq!(result.code(), "unresolvable");
    assert!(result.published_path().is_none());
    assert!(!moved.join("copy.pdf").exists());
    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    assert!(moved.join("copy.pdf.part").is_symlink());
    f.assert_original();
}

#[test]
fn a_symlink_replacing_the_gate_root_is_not_followed() {
    let base = tempfile::tempdir().unwrap();
    let root = base.path().join("root");
    std::fs::create_dir(&root).unwrap();
    let gate = Gate::new(&[&root]).unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::rename(&root, base.path().join("held")).unwrap();
    symlink(outside.path(), &root).unwrap();
    assert!(gate.output_directory(root.to_str().unwrap()).is_err());
    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
}

#[test]
fn write_errors_keep_their_primary_diagnosis_and_cleanup_is_best_effort() {
    for (errno, expected) in [
        (rustix::io::Errno::NOSPC, "disk_full"),
        (rustix::io::Errno::DQUOT, "disk_full"),
        (rustix::io::Errno::ACCESS, "permission_denied"),
        (rustix::io::Errno::PERM, "permission_denied"),
        (rustix::io::Errno::ROFS, "permission_denied"),
        (rustix::io::Errno::IO, "write_failed"),
    ] {
        let mut f = Fixture::new();
        let bytes = f.prepare("run", b"prepared".to_vec());
        let mut ops = Hook(|phase| {
            if phase == Phase::Write {
                Err(errno.into())
            } else {
                Ok(())
            }
        });
        let e = publish_with(
            &f.registry,
            &f.gate,
            bytes,
            Destination::Automatic,
            &Cancellation::default(),
            &mut ops,
        )
        .unwrap_err();
        assert_eq!(e.code(), expected);
        assert!(e.published_path().is_none());
        f.assert_original();
        f.assert_no_temp();
    }
}

#[test]
fn input_changed_while_writing_is_not_published() {
    let mut f = Fixture::new();
    let bytes = f.prepare("run", b"prepared".to_vec());
    let mut ops = Hook(|phase| {
        if phase == Phase::FileSync {
            std::fs::write(&f.input, b"changed")?;
        }
        Ok(())
    });
    let e = publish_with(
        &f.registry,
        &f.gate,
        bytes,
        Destination::Automatic,
        &Cancellation::default(),
        &mut ops,
    )
    .unwrap_err();
    assert_eq!(e.code(), "input_changed_since_inspection");
    assert!(!f.destination().exists());
    f.assert_no_temp();
}

#[test]
fn temporary_directory_swap_cannot_redirect_published_bytes_or_delete_replacements() {
    let mut f = Fixture::new();
    let bytes = f.prepare("run", b"prepared".to_vec());
    let original = f.dir.path().join("report (sanitized).pdf.part");
    let held = f.dir.path().join("held.part");
    let outside = tempfile::tempdir().unwrap();
    let mut ops = Hook(|phase| {
        if phase == Phase::Write {
            std::fs::rename(&original, &held)?;
            symlink(outside.path(), &original)?;
        }
        Ok(())
    });
    let output = publish_with(
        &f.registry,
        &f.gate,
        bytes,
        Destination::Automatic,
        &Cancellation::default(),
        &mut ops,
    )
    .unwrap();
    assert_eq!(std::fs::read(output.path()).unwrap(), b"prepared");
    assert!(!output.cleanup_complete());
    assert!(original.is_symlink());
    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    f.assert_original();
}

#[test]
fn post_link_replacement_is_reported_and_never_rolled_back() {
    let mut f = Fixture::new();
    let bytes = f.prepare("run", b"prepared".to_vec());
    let path = f.destination();
    let mut ops = Hook(|phase| {
        if phase == Phase::DirectorySync {
            std::fs::remove_file(&path)?;
            std::fs::write(&path, b"new occupant")?;
        }
        Ok(())
    });
    let e = publish_with(
        &f.registry,
        &f.gate,
        bytes,
        Destination::Automatic,
        &Cancellation::default(),
        &mut ops,
    )
    .unwrap_err();
    assert_eq!(e.code(), "output_not_from_this_run");
    assert_eq!(e.published_path(), Some(path.as_path()));
    assert_eq!(std::fs::read(&path).unwrap(), b"new occupant");
    f.assert_original();
    f.assert_no_temp();
}

#[test]
fn cancellation_during_a_chunked_write_does_not_publish_partial_bytes() {
    let mut f = Fixture::new();
    let bytes = f.prepare("run", vec![b'x'; 192 * 1024]);
    struct CancelWrite<'a> {
        cancellation: &'a Cancellation,
        writes: usize,
    }
    impl Operations for CancelWrite<'_> {
        fn write(&mut self, file: &mut File, bytes: &[u8]) -> io::Result<()> {
            file.write_all(bytes)?;
            self.writes += 1;
            self.cancellation.cancel();
            Ok(())
        }
    }
    let cancel = Cancellation::default();
    let mut ops = CancelWrite {
        cancellation: &cancel,
        writes: 0,
    };
    let e = publish_with(
        &f.registry,
        &f.gate,
        bytes,
        Destination::Automatic,
        &cancel,
        &mut ops,
    )
    .unwrap_err();
    assert_eq!(e.code(), "cancelled");
    assert_eq!(ops.writes, 1);
    assert!(!f.destination().exists());
    f.assert_original();
    f.assert_no_temp();
}

#[test]
fn real_sync_calls_reject_a_socket() {
    let (a, b) = std::os::unix::net::UnixStream::pair().unwrap();
    let file = File::from(std::os::fd::OwnedFd::from(a));
    assert!(System.sync_file(&file).is_err());
    let directory = OutputDirectory {
        fd: b.into(),
        path: PathBuf::from("socket"),
    };
    assert!(System.sync_directory(&directory).is_err());
    #[cfg(target_os = "macos")]
    assert!(full_sync(&file).is_err());
}

// Process death cannot unwind through Temp::drop. A child test process exits
// immediately at each real syscall boundary and leaves its actual files.
#[test]
fn crash_child() {
    let Some(root) = std::env::var_os("BEFORESHARE_WRITER_CRASH_ROOT") else {
        return;
    };
    let phase = std::env::var("BEFORESHARE_WRITER_CRASH_PHASE").unwrap();
    let gate = Gate::new(&[Path::new(&root)]).unwrap();
    let input = Path::new(&root).join("input.pdf");
    let mut registry = Registry::new(NonZeroUsize::new(1).unwrap());
    let record = registry
        .intake(&gate, input.to_str().unwrap(), "crash", 32)
        .unwrap();
    let confirmed = registry.confirm(&gate, &record).unwrap();
    let approval = registry
        .approve(&confirmed, &["remove_pdf_metadata_field"])
        .unwrap();
    let permit = registry.authorize_sanitize(&gate, &approval).unwrap();
    let bytes = registry
        .finish_sanitize(&gate, permit, b"complete output".to_vec())
        .unwrap();
    struct Crash {
        phase: String,
    }
    impl Operations for Crash {
        fn at(&mut self, at: Phase) -> io::Result<()> {
            let exit = matches!(
                (self.phase.as_str(), at),
                ("after_reserve", Phase::Write)
                    | ("after_write", Phase::FileSync)
                    | ("after_publish", Phase::DirectorySync)
            );
            if exit {
                std::process::exit(73);
            }
            Ok(())
        }
        fn write(&mut self, file: &mut File, bytes: &[u8]) -> io::Result<()> {
            if self.phase == "during_write" {
                file.write_all(&bytes[..3])?;
                std::process::exit(73);
            }
            file.write_all(bytes)
        }
    }
    let _ = publish_with(
        &registry,
        &gate,
        bytes,
        Destination::Automatic,
        &Cancellation::default(),
        &mut Crash { phase },
    );
    panic!("crash point was not reached");
}

#[test]
fn process_death_leaves_only_absent_or_complete_destinations_and_marked_debris() {
    for phase in [
        "after_reserve",
        "during_write",
        "after_write",
        "after_publish",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("input.pdf");
        std::fs::write(&input, b"original").unwrap();
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "safe_output::tests::crash_child", "--nocapture"])
            .env("BEFORESHARE_WRITER_CRASH_ROOT", dir.path())
            .env("BEFORESHARE_WRITER_CRASH_PHASE", phase)
            .output()
            .unwrap();
        assert_eq!(
            child.status.code(),
            Some(73),
            "{phase}: {}",
            String::from_utf8_lossy(&child.stderr)
        );
        assert_eq!(std::fs::read(input).unwrap(), b"original");
        let output = dir.path().join("input (sanitized).pdf");
        if phase == "after_publish" {
            assert_eq!(std::fs::read(output).unwrap(), b"complete output");
        } else {
            assert!(!output.exists());
        }
        let temp = dir.path().join("input (sanitized).pdf.part");
        assert!(temp.is_dir());
        assert_eq!(
            std::fs::metadata(&temp).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let payload = temp.join("output.part");
        assert!(payload.exists());
        assert_eq!(
            std::fs::metadata(&payload).unwrap().permissions().mode() & 0o777,
            0o600
        );
        if phase == "during_write" {
            assert_eq!(std::fs::read(payload).unwrap(), b"com");
        }
    }
}
