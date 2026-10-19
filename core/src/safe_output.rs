//! Independent-copy publication. No format repair or verification is implied.
//! Files and names are accessed relative to pinned directory descriptors.
use crate::{
    path_gate::{Gate, OutputDirectory},
    stage_binding::{ProducedBytes, Registry},
};
use rustix::fs::{self, AtFlags, Mode, OFlags};
use std::{
    ffi::OsString,
    fs::File,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    },
    time::{Duration, Instant},
};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Naming {
    marker: String,
    sequence_separator: String,
    first_sequence_number: usize,
    max_attempts: usize,
}
fn naming() -> &'static Naming {
    static NAMING: OnceLock<Naming> = OnceLock::new();
    NAMING.get_or_init(|| {
        let rules: serde_json::Value =
            serde_json::from_str(include_str!("../../schemas/v1/output-rules.json"))
                .expect("output rules");
        assert_eq!(rules["naming"]["extensionRule"], "last-dot");
        assert_eq!(rules["writeProtocol"]["claim"], "exclusive-create");
        assert_eq!(rules["writeProtocol"]["then"], "write-temp-then-link");
        serde_json::from_value(rules["naming"].clone()).expect("canonical naming")
    })
}
fn marker() -> &'static str {
    static MARKER: OnceLock<String> = OnceLock::new();
    MARKER.get_or_init(|| {
        let rules: serde_json::Value =
            serde_json::from_str(include_str!("../../schemas/v1/temp-rules.json"))
                .expect("temp rules");
        assert_eq!(rules["mode"]["octal"], "0600");
        assert_eq!(rules["location"]["policy"], "beside-destination");
        rules["incompleteMarker"]
            .as_str()
            .expect("marker")
            .to_owned()
    })
}

/// Same last-dot naming as the JavaScript reference. A leading dot is a name.
fn candidate_name(name: &str, attempt: usize) -> String {
    let dot = name.rfind('.').filter(|&dot| dot > 0).unwrap_or(name.len());
    let (stem, extension) = name.split_at(dot);
    let n = naming();
    let sequence = if attempt == 1 {
        String::new()
    } else {
        format!(
            "{}{}",
            n.sequence_separator,
            n.first_sequence_number + attempt - 2
        )
    };
    format!("{stem}{}{sequence}{extension}", n.marker)
}

pub enum Destination<'a> {
    Automatic,
    Explicit(&'a str),
}
#[derive(Default)]
pub struct Cancellation(AtomicBool);
impl Cancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub fn is_requested(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Reserve,
    Write,
    FileSync,
    Publish,
    DirectorySync,
    DriveSync,
}
/// Error names reuse the canonical output/failure tables. A path is available
/// separately only when the atomic link already succeeded; never retry blindly.
pub struct Error {
    code: &'static str,
    phase: Phase,
    published: Option<PathBuf>,
}
impl Error {
    pub fn code(&self) -> &'static str {
        self.code
    }
    pub fn phase(&self) -> Phase {
        self.phase
    }
    pub fn published_path(&self) -> Option<&Path> {
        self.published.as_deref()
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} at {:?}; published={}",
            self.code,
            self.phase,
            self.published.is_some()
        )
    }
}
impl std::fmt::Debug for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}
impl std::error::Error for Error {}
fn error(code: &'static str, phase: Phase) -> Error {
    Error {
        code,
        phase,
        published: None,
    }
}
fn classify(e: io::Error, phase: Phase) -> Error {
    let code = match e.raw_os_error() {
        Some(n)
            if n == rustix::io::Errno::NOSPC.raw_os_error()
                || n == rustix::io::Errno::DQUOT.raw_os_error() =>
        {
            "disk_full"
        }
        Some(n)
            if [
                rustix::io::Errno::ACCESS,
                rustix::io::Errno::PERM,
                rustix::io::Errno::ROFS,
            ]
            .iter()
            .any(|e| e.raw_os_error() == n) =>
        {
            "permission_denied"
        }
        _ => "write_failed",
    };
    error(code, phase)
}
fn binding(registry: &Registry, gate: &Gate, bytes: &ProducedBytes) -> Result<(), Error> {
    registry.confirm_for_publish(gate, bytes).map_err(|e| {
        use crate::stage_binding::Error as IdentityError;
        let code = match e {
            IdentityError::Rejected(reason) => reason.as_str(),
            IdentityError::Path(reason) => reason.reason(),
            _ => "write_failed",
        };
        error(code, Phase::Publish)
    })
}

/// Complete, durably published bytes. This is not a verification verdict.
pub struct PublishedOutput {
    path: PathBuf,
    prepared: ProducedBytes,
    cleanup_complete: bool,
    sync_time: Duration,
}
impl PublishedOutput {
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn prepared(&self) -> &ProducedBytes {
        &self.prepared
    }
    pub fn cleanup_complete(&self) -> bool {
        self.cleanup_complete
    }
    pub fn sync_time(&self) -> Duration {
        self.sync_time
    }
}
impl std::fmt::Debug for PublishedOutput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PublishedOutput").finish_non_exhaustive()
    }
}

struct Temp<'a> {
    parent: &'a OutputDirectory,
    directory: File,
    file: File,
    name: OsString,
    cleaned: bool,
}
impl Temp<'_> {
    fn cleanup(&mut self) -> bool {
        self.cleaned = true;
        // Never remove an unrelated entry planted at our old directory name.
        let same = fs::statat(&self.parent.fd, &self.name, AtFlags::SYMLINK_NOFOLLOW)
            .ok()
            .zip(fs::fstat(&self.directory).ok())
            .is_some_and(|(a, b)| a.st_dev == b.st_dev && a.st_ino == b.st_ino);
        let content_removed =
            fs::unlinkat(&self.directory, "output.part", AtFlags::empty()).is_ok();
        same && content_removed
            && fs::unlinkat(&self.parent.fd, &self.name, AtFlags::REMOVEDIR).is_ok()
    }
}
impl Drop for Temp<'_> {
    fn drop(&mut self) {
        if !self.cleaned {
            self.cleanup();
        }
    }
}
fn reserve<'a>(parent: &'a OutputDirectory, name: OsString) -> io::Result<Temp<'a>> {
    fs::mkdirat(&parent.fd, &name, Mode::from_raw_mode(0o700))?;
    let directory = File::from(fs::openat(
        &parent.fd,
        &name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?);
    let stat = fs::fstat(&directory)?;
    if stat.st_uid != rustix::process::geteuid().as_raw() || stat.st_mode & 0o777 != 0o700 {
        return Err(io::Error::other("temporary directory ownership changed"));
    }
    let payload = fs::openat(
        &directory,
        "output.part",
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_raw_mode(0o600),
    );
    match payload {
        Ok(file) => Ok(Temp {
            parent,
            directory,
            file: File::from(file),
            name,
            cleaned: false,
        }),
        Err(e) => {
            // Directory is private and contains no output; leave the marker if
            // removal fails. Never turn a write diagnosis into a cleanup one.
            let _ = fs::unlinkat(&parent.fd, &name, AtFlags::REMOVEDIR);
            Err(e.into())
        }
    }
}

// Private syscall seam: tests inject failures at the real publication boundaries.
trait Operations {
    fn at(&mut self, _phase: Phase) -> io::Result<()> {
        Ok(())
    }
    fn write(&mut self, file: &mut File, bytes: &[u8]) -> io::Result<()> {
        file.write_all(bytes)
    }
    fn sync_file(&mut self, file: &File) -> io::Result<()> {
        file.sync_all()?;
        full_sync(file)
    }
    fn sync_directory(&mut self, directory: &OutputDirectory) -> io::Result<()> {
        fs::fsync(&directory.fd).map_err(Into::into)
    }
    fn sync_drive(&mut self, file: &File) -> io::Result<()> {
        full_sync(file)
    }
}
struct System;
impl Operations for System {}
fn full_sync(file: &File) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        fs::fcntl_fullfsync(file).map_err(Into::into)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = file;
        Ok(())
    }
}

fn directory_still_named(gate: &Gate, directory: &OutputDirectory) -> bool {
    let Some(raw) = directory.path.to_str() else {
        return false;
    };
    let Ok(current) = gate.output_directory(raw) else {
        return false;
    };
    fs::fstat(&current.fd)
        .ok()
        .zip(fs::fstat(&directory.fd).ok())
        .is_some_and(|(a, b)| a.st_dev == b.st_dev && a.st_ino == b.st_ino)
}

/// Consume one prepared output and publish without replacing any existing name.
/// Cancellation stops before link; after link, finish durability even if cancelled.
/// A post-link failure leaves a complete file and reports its path with uncertain
/// durability. It never removes or overwrites that published entry as a rollback.
pub fn publish(
    registry: &Registry,
    gate: &Gate,
    prepared: ProducedBytes,
    destination: Destination<'_>,
    cancellation: &Cancellation,
) -> Result<PublishedOutput, Error> {
    publish_with(
        registry,
        gate,
        prepared,
        destination,
        cancellation,
        &mut System,
    )
}
fn publish_with(
    registry: &Registry,
    gate: &Gate,
    prepared: ProducedBytes,
    destination: Destination<'_>,
    cancellation: &Cancellation,
    ops: &mut impl Operations,
) -> Result<PublishedOutput, Error> {
    binding(registry, gate, &prepared)?;
    let input = prepared.input_path();
    let explicit = matches!(destination, Destination::Explicit(_));
    let selected = match destination {
        Destination::Automatic => input,
        Destination::Explicit(raw) => Path::new(raw),
    };
    let raw_leaf = selected
        .as_os_str()
        .to_str()
        .and_then(|s| s.rsplit('/').next())
        .ok_or_else(|| error("empty_or_null_byte", Phase::Reserve))?;
    if raw_leaf.is_empty() || raw_leaf == "." || raw_leaf == ".." || raw_leaf.contains('\0') {
        return Err(error("empty_or_null_byte", Phase::Reserve));
    }
    if explicit {
        let input_raw = input
            .to_str()
            .ok_or_else(|| error("unresolvable", Phase::Reserve))?;
        let protected = gate
            .for_read(input_raw)
            .map_err(|e| error(e.reason(), Phase::Reserve))?;
        let selected_raw = selected
            .to_str()
            .ok_or_else(|| error("unresolvable", Phase::Reserve))?;
        gate.for_write(selected_raw, Some(&protected))
            .map_err(|e| error(e.reason(), Phase::Reserve))?;
    }
    let parent_path = selected
        .parent()
        .and_then(Path::to_str)
        .ok_or_else(|| error("not_absolute", Phase::Reserve))?;
    let parent = gate
        .output_directory(parent_path)
        .map_err(|e| error(e.reason(), Phase::Reserve))?;
    let candidates: Vec<OsString> = if explicit {
        vec![raw_leaf.into()]
    } else {
        (1..=naming().max_attempts)
            .map(|n| candidate_name(raw_leaf, n).into())
            .collect()
    };
    let stop = |phase| {
        if cancellation.is_requested() {
            Err(error("cancelled", phase))
        } else {
            Ok(())
        }
    };
    let mut reserved = None;
    for (i, candidate) in candidates.iter().enumerate() {
        stop(Phase::Reserve)?;
        ops.at(Phase::Reserve)
            .map_err(|e| classify(e, Phase::Reserve))?;
        let mut name = candidate.clone();
        name.push(marker());
        match reserve(&parent, name) {
            Ok(temp) => {
                reserved = Some((i, temp));
                break;
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(classify(e, Phase::Reserve)),
        }
    }
    let (start, mut temp) = reserved.ok_or_else(|| {
        error(
            if explicit {
                "temp_name_taken"
            } else {
                "no_free_name"
            },
            Phase::Reserve,
        )
    })?;
    stop(Phase::Write)?;
    ops.at(Phase::Write)
        .map_err(|e| classify(e, Phase::Write))?;
    for chunk in prepared.bytes().chunks(64 * 1024) {
        stop(Phase::Write)?;
        ops.write(&mut temp.file, chunk)
            .map_err(|e| classify(e, Phase::Write))?;
    }
    stop(Phase::Write)?;
    ops.at(Phase::FileSync)
        .map_err(|e| classify(e, Phase::FileSync))?;
    stop(Phase::FileSync)?;
    let clock = Instant::now();
    ops.sync_file(&temp.file)
        .map_err(|e| classify(e, Phase::FileSync))?;
    let mut sync_time = clock.elapsed();
    binding(registry, gate, &prepared)?;
    for candidate in &candidates[start..] {
        ops.at(Phase::Publish)
            .map_err(|e| classify(e, Phase::Publish))?;
        stop(Phase::Publish)?;
        if !directory_still_named(gate, &parent) {
            return Err(error("unresolvable", Phase::Publish));
        }
        match fs::linkat(
            &temp.directory,
            "output.part",
            &parent.fd,
            candidate,
            AtFlags::empty(),
        ) {
            Ok(()) => {
                let path = parent.path.join(candidate);
                // Once linked, cancellation cannot undo someone else's complete
                // file. Sync failures carry a path instead of claiming no output.
                for phase in [Phase::DirectorySync, Phase::DriveSync] {
                    let clock = Instant::now();
                    let result = ops.at(phase).and_then(|()| match phase {
                        Phase::DirectorySync => ops.sync_directory(&parent),
                        _ => ops.sync_drive(&temp.file),
                    });
                    sync_time += clock.elapsed();
                    result.map_err(|e| {
                        let mut e = classify(e, phase);
                        e.published = Some(path.clone());
                        e
                    })?;
                }
                let same_output = fs::statat(&parent.fd, candidate, AtFlags::SYMLINK_NOFOLLOW)
                    .ok()
                    .zip(fs::fstat(&temp.file).ok())
                    .is_some_and(|(a, b)| a.st_dev == b.st_dev && a.st_ino == b.st_ino);
                if !directory_still_named(gate, &parent) || !same_output {
                    let mut e = error("output_not_from_this_run", Phase::DirectorySync);
                    e.published = Some(path);
                    return Err(e);
                }
                let cleanup_complete = temp.cleanup();
                // Attempt to persist cleanup. Only the published output owns
                // the full durability barrier; harmless marked debris may still
                // reappear after power loss, especially on Apple drive caches.
                let cleanup_complete = cleanup_complete && fs::fsync(&parent.fd).is_ok();
                return Ok(PublishedOutput {
                    path,
                    prepared,
                    cleanup_complete,
                    sync_time,
                });
            }
            Err(rustix::io::Errno::EXIST) => {}
            Err(e) => return Err(classify(e.into(), Phase::Publish)),
        }
    }
    Err(error(
        if explicit {
            "destination_exists"
        } else {
            "no_free_name"
        },
        Phase::Publish,
    ))
}

#[cfg(test)]
mod tests;
