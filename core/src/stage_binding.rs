//! In-memory stage binding. Opaque tokens keep approvals attached to one
//! registry, one run, one path and one immutable input snapshot. No token is
//! deserializable, and none of these APIs performs remediation or verification.
use std::collections::{BTreeMap, BTreeSet};
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use crate::{
    identity::sha256_hex,
    limits,
    path_gate::{self, Gate, LimitedReadError},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Rejection {
    UnknownRun,
    StageOutOfOrder,
    InputChangedSinceInspection,
    InputReplacedDuringInspection,
    OutputNotFromThisRun,
    DuplicateRunId,
    NotThePathInspected,
}

impl Rejection {
    pub const ALL: &'static [Self] = &[
        Self::UnknownRun,
        Self::StageOutOfOrder,
        Self::InputChangedSinceInspection,
        Self::InputReplacedDuringInspection,
        Self::OutputNotFromThisRun,
        Self::DuplicateRunId,
        Self::NotThePathInspected,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnknownRun => "unknown_run",
            Self::StageOutOfOrder => "stage_out_of_order",
            Self::InputChangedSinceInspection => "input_changed_since_inspection",
            Self::InputReplacedDuringInspection => "input_replaced_during_inspection",
            Self::OutputNotFromThisRun => "output_not_from_this_run",
            Self::DuplicateRunId => "duplicate_run_id",
            Self::NotThePathInspected => "not_the_path_inspected",
        }
    }
}

pub enum Error {
    Rejected(Rejection),
    Path(path_gate::Rejected),
    Read(LimitedReadError),
    InvalidArgument(&'static str),
    CapacityExhausted,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rejected(reason) => f.write_str(reason.as_str()),
            Self::Path(reason) => write!(f, "input path refused: {}", reason.reason()),
            Self::Read(LimitedReadError::TooLarge) => f.write_str("input_too_large"),
            Self::Read(LimitedReadError::Io(error)) => {
                write!(f, "input read failed: {}", error.kind())
            }
            Self::InvalidArgument(reason) => f.write_str(reason),
            Self::CapacityExhausted => {
                f.write_str("the identity registry has exhausted its run capacity")
            }
        }
    }
}
impl std::fmt::Debug for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}
impl std::error::Error for Error {}

struct Input {
    run_id: String,
    requested: String,
    path: PathBuf,
    sha256: String,
    bytes: Box<[u8]>,
    limit: u64,
}

/// Constructed only after bounded intake and hashing have finished.
pub struct IntakeRecord {
    input: Arc<Input>,
}
impl IntakeRecord {
    pub fn bytes(&self) -> &[u8] {
        &self.input.bytes
    }
    pub fn sha256(&self) -> &str {
        &self.input.sha256
    }
    pub fn path(&self) -> &Path {
        &self.input.path
    }
    pub fn run_id(&self) -> &str {
        &self.input.run_id
    }
    pub fn size_bytes(&self) -> u64 {
        self.input.bytes.len() as u64
    }
}

/// The original selected pathname resolved and hashed to the same snapshot at
/// inspection completion. This does not claim that any detector succeeded.
pub struct ConfirmedInspection {
    input: Arc<Input>,
}

/// The caller has explicitly selected these actions for a confirmed snapshot.
/// A future UI/MCP adapter must obtain that selection from the user; this type
/// cannot determine whether a human approved a choice made by its caller.
pub struct Approval {
    input: Arc<Input>,
    actions: Vec<String>,
}
impl Approval {
    pub fn run_id(&self) -> &str {
        &self.input.run_id
    }
    pub fn input_sha256(&self) -> &str {
        &self.input.sha256
    }
    pub fn actions(&self) -> &[String] {
        &self.actions
    }
}

/// A one-use permit carrying the freshly checked bytes. An adapter transforms
/// these bytes rather than reopening a path after approval validation.
pub struct SanitizeInput {
    input: Arc<Input>,
    bytes: Box<[u8]>,
    actions: Vec<String>,
}
impl SanitizeInput {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn input_sha256(&self) -> &str {
        &self.input.sha256
    }
    pub fn actions(&self) -> &[String] {
        &self.actions
    }
}

/// A prepared output snapshot, not a published file or a verification verdict.
pub struct ProducedBytes {
    input: Arc<Input>,
    bytes: Box<[u8]>,
    sha256: String,
}
impl ProducedBytes {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
    pub fn input_sha256(&self) -> &str {
        &self.input.sha256
    }
    pub fn run_id(&self) -> &str {
        &self.input.run_id
    }
}

// Debug output must not accidentally print file content, paths or hashes.
macro_rules! opaque_debug {
    ($($name:ty),+) => { $(impl std::fmt::Debug for $name {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct(stringify!($name)).finish_non_exhaustive()
        }
    })+ };
}
opaque_debug!(
    IntakeRecord,
    ConfirmedInspection,
    Approval,
    SanitizeInput,
    ProducedBytes
);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Captured,
    Confirmed,
    Approved,
    Sanitizing,
    Produced,
}
struct Active {
    input: Arc<Input>,
    phase: Phase,
    output_sha256: Option<String>,
}

/// A bounded, process-local session. Issued IDs remain spent after release.
/// Callers choose a finite capacity; creating another registry does not make
/// existing tokens valid in it, even if run IDs and file bytes are identical.
pub struct Registry {
    capacity: NonZeroUsize,
    used: BTreeSet<String>,
    active: BTreeMap<String, Active>,
}

impl Registry {
    pub fn new(capacity: NonZeroUsize) -> Self {
        Self {
            capacity,
            used: BTreeSet::new(),
            active: BTreeMap::new(),
        }
    }

    pub fn intake(
        &mut self,
        gate: &Gate,
        requested: &str,
        run_id: &str,
        limit: u64,
    ) -> Result<IntakeRecord, Error> {
        if run_id.is_empty() {
            return Err(Error::InvalidArgument("intake requires a run identifier"));
        }
        if self.used.contains(run_id) {
            return Err(Error::Rejected(Rejection::DuplicateRunId));
        }
        if self.used.len() >= self.capacity.get() {
            return Err(Error::CapacityExhausted);
        }
        if limit == 0 || limit > limits::defaults().input_bytes {
            return Err(Error::InvalidArgument(
                "input limit must be positive and within the canonical budget",
            ));
        }
        let resolved = gate.for_read(requested).map_err(Error::Path)?;
        let bytes = path_gate::read_file_limited(&resolved, limit)
            .map_err(Error::Read)?
            .into_boxed_slice();
        let sha256 = sha256_hex(&bytes);
        let input = Arc::new(Input {
            run_id: run_id.into(),
            requested: requested.into(),
            path: resolved.path().to_owned(),
            sha256,
            bytes,
            limit,
        });
        self.used.insert(run_id.into());
        self.active.insert(
            run_id.into(),
            Active {
                input: Arc::clone(&input),
                phase: Phase::Captured,
                output_sha256: None,
            },
        );
        Ok(IntakeRecord { input })
    }

    fn active_for(&self, input: &Arc<Input>) -> Result<&Active, Error> {
        self.active
            .get(&input.run_id)
            .filter(|active| Arc::ptr_eq(&active.input, input))
            .ok_or(Error::Rejected(Rejection::UnknownRun))
    }

    fn require(&self, input: &Arc<Input>, phase: Phase) -> Result<(), Error> {
        if self.active_for(input)?.phase != phase {
            return Err(Error::Rejected(Rejection::StageOutOfOrder));
        }
        Ok(())
    }

    fn advance(&mut self, input: &Arc<Input>, phase: Phase) {
        self.active
            .get_mut(&input.run_id)
            .expect("validated active run")
            .phase = phase;
    }

    fn current_bytes(gate: &Gate, input: &Input, changed: Rejection) -> Result<Box<[u8]>, Error> {
        // Re-resolve the ORIGINAL spelling, not the pinned intake handle. A
        // pathname or an in-root alias may have been replaced during inspection.
        let resolved = gate.for_read(&input.requested).map_err(Error::Path)?;
        if resolved.path() != input.path {
            return Err(Error::Rejected(Rejection::NotThePathInspected));
        }
        let bytes = match path_gate::read_file_limited(&resolved, input.limit) {
            Ok(bytes) => bytes.into_boxed_slice(),
            Err(LimitedReadError::TooLarge) => return Err(Error::Rejected(changed)),
            Err(error) => return Err(Error::Read(error)),
        };
        if sha256_hex(&bytes) != input.sha256 {
            return Err(Error::Rejected(changed));
        }
        Ok(bytes)
    }

    pub fn confirm(
        &mut self,
        gate: &Gate,
        record: &IntakeRecord,
    ) -> Result<ConfirmedInspection, Error> {
        self.require(&record.input, Phase::Captured)?;
        Self::current_bytes(
            gate,
            &record.input,
            Rejection::InputReplacedDuringInspection,
        )?;
        self.advance(&record.input, Phase::Confirmed);
        Ok(ConfirmedInspection {
            input: Arc::clone(&record.input),
        })
    }

    pub fn approve(
        &mut self,
        confirmed: &ConfirmedInspection,
        actions: &[&str],
    ) -> Result<Approval, Error> {
        self.require(&confirmed.input, Phase::Confirmed)?;
        static ACTIONS: OnceLock<BTreeSet<String>> = OnceLock::new();
        let known = ACTIONS.get_or_init(|| {
            let enums: serde_json::Value =
                serde_json::from_str(include_str!("../../schemas/v1/enums.schema.json"))
                    .expect("canonical enums");
            enums["$defs"]["remediationAction"]["enum"]
                .as_array()
                .expect("remediation actions")
                .iter()
                .map(|value| value.as_str().expect("action name").to_owned())
                .collect()
        });
        if actions.is_empty() || actions.iter().any(|action| !known.contains(*action)) {
            return Err(Error::InvalidArgument(
                "approval requires nonempty canonical remediation actions",
            ));
        }
        self.advance(&confirmed.input, Phase::Approved);
        Ok(Approval {
            input: Arc::clone(&confirmed.input),
            actions: actions.iter().map(|s| (*s).into()).collect(),
        })
    }

    pub fn authorize_sanitize(
        &mut self,
        gate: &Gate,
        approval: &Approval,
    ) -> Result<SanitizeInput, Error> {
        self.require(&approval.input, Phase::Approved)?;
        let bytes = Self::current_bytes(
            gate,
            &approval.input,
            Rejection::InputChangedSinceInspection,
        )?;
        self.advance(&approval.input, Phase::Sanitizing);
        Ok(SanitizeInput {
            input: Arc::clone(&approval.input),
            bytes,
            actions: approval.actions.clone(),
        })
    }

    pub fn finish_sanitize(
        &mut self,
        gate: &Gate,
        permit: SanitizeInput,
        output: Vec<u8>,
    ) -> Result<ProducedBytes, Error> {
        self.require(&permit.input, Phase::Sanitizing)?;
        Self::current_bytes(gate, &permit.input, Rejection::InputChangedSinceInspection)?;
        let sha256 = sha256_hex(&output);
        let active = self
            .active
            .get_mut(&permit.input.run_id)
            .expect("validated active run");
        active.phase = Phase::Produced;
        active.output_sha256 = Some(sha256.clone());
        Ok(ProducedBytes {
            input: permit.input,
            bytes: output.into_boxed_slice(),
            sha256,
        })
    }

    /// Checks identity only. A real verifier still has to read the relevant
    /// metadata/text/rendering surfaces and establish the selected removals.
    pub fn check_verify_allowed(
        &self,
        produced: &ProducedBytes,
        input_sha256: &str,
        output_bytes: &[u8],
    ) -> Result<(), Error> {
        self.require(&produced.input, Phase::Produced)?;
        if input_sha256 != produced.input.sha256 {
            return Err(Error::Rejected(Rejection::InputChangedSinceInspection));
        }
        let expected = self
            .active_for(&produced.input)?
            .output_sha256
            .as_deref()
            .expect("produced output hash");
        if sha256_hex(output_bytes) != expected {
            return Err(Error::Rejected(Rejection::OutputNotFromThisRun));
        }
        Ok(())
    }

    pub fn release(&mut self, run_id: &str) -> bool {
        self.active.remove(run_id).is_some()
    }
}
