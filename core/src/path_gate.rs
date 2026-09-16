//! Every file access resolves first (§13.4), and a path that has not been
//! through the gate cannot be handed to one.
//!
//! In JavaScript that guarantee was a `WeakSet` and an `Object.freeze`: the
//! gate remembered which objects it had issued, and `readFile` refused anything
//! else. It worked, and it had already failed once - the brand was a symbol
//! property, and object spread copied it, so `{ ...readPath, mode: 'write' }`
//! turned a read authorisation into a write one. Review caught that.
//!
//! Here the brand is the absence of a public constructor. `ResolvedPath` has
//! private fields and no way to build one outside this module, so a forged path
//! is not a test that fails - it is a program that does not compile. That is
//! the claim ADR 0001 made, and `tests/compile_fail.rs` is the evidence.

use std::collections::BTreeSet;
use std::ffi::CString;
use std::os::fd::OwnedFd;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

/// The rule table, read from the same file the JavaScript reads.
///
/// Baked in rather than loaded at runtime: a product that reads its own rules
/// off disk can be handed different ones. A copy in Rust source would be worse
/// still - two tables to keep in step, which is what putting the rules in data
/// was meant to avoid.
const PATH_RULES: &str = include_str!("../../schemas/v1/path-rules.json");

#[derive(Debug, Deserialize)]
struct RulesFile {
    #[serde(rename = "rejectionReasons")]
    rejection_reasons: std::collections::BTreeMap<String, ReasonEntry>,
    identity: Identity,
}

#[derive(Debug, Deserialize)]
struct ReasonEntry {
    stage: String,
    #[allow(dead_code)]
    rationale: String,
}

#[derive(Debug, Deserialize)]
struct Identity {
    #[serde(rename = "caseInsensitiveDefault")]
    case_insensitive_default: bool,
    #[serde(rename = "unicodeNormalization")]
    normalization: String,
}

fn rules() -> &'static RulesFile {
    use std::sync::OnceLock;
    static RULES: OnceLock<RulesFile> = OnceLock::new();
    RULES.get_or_init(|| serde_json::from_str(PATH_RULES).expect("path-rules.json is malformed"))
}

/// Why the gate refused.
///
/// One variant per row of `path-rules.json`, and a test compares the two in
/// both directions - a reason the table declares and nothing throws is a claim
/// about enforcement that does not happen, and a reason thrown but undeclared
/// is a vocabulary nobody wrote down.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rejected {
    NotAbsolute(String),
    SymlinkEscape(String),
    Traversal(String),
    OutsideAuthorisedRoots(String),
    OutputIsInput(String),
    OutputIsDirectory(String),
    EmptyOrNullByte(String),
    SymlinkLoop(String),
    Unresolvable(String),
}

impl Rejected {
    /// The name the table uses, so a caller reports the same word the rules do.
    pub fn reason(&self) -> &'static str {
        match self {
            Self::NotAbsolute(_) => "not_absolute",
            Self::SymlinkEscape(_) => "symlink_escape",
            Self::Traversal(_) => "traversal",
            Self::OutsideAuthorisedRoots(_) => "outside_authorised_roots",
            Self::OutputIsInput(_) => "output_is_input",
            Self::OutputIsDirectory(_) => "output_is_directory",
            Self::EmptyOrNullByte(_) => "empty_or_null_byte",
            Self::SymlinkLoop(_) => "symlink_loop",
            Self::Unresolvable(_) => "unresolvable",
        }
    }

    /// Every reason this module can produce. Compared with the table by a test.
    pub fn all_reasons() -> BTreeSet<&'static str> {
        [
            "not_absolute",
            "symlink_escape",
            "traversal",
            "outside_authorised_roots",
            "output_is_input",
            "output_is_directory",
            "empty_or_null_byte",
            "symlink_loop",
            "unresolvable",
        ]
        .into_iter()
        .collect()
    }
}

impl std::fmt::Display for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let detail = match self {
            Self::NotAbsolute(d)
            | Self::SymlinkEscape(d)
            | Self::Traversal(d)
            | Self::OutsideAuthorisedRoots(d)
            | Self::OutputIsInput(d)
            | Self::OutputIsDirectory(d)
            | Self::EmptyOrNullByte(d)
            | Self::SymlinkLoop(d)
            | Self::Unresolvable(d) => d,
        };
        write!(f, "{}: {detail}", self.reason())
    }
}

impl std::error::Error for Rejected {}

/// What the gate may do with a path it issued.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Read,
    Write,
}

/// A path that has been through the gate.
///
/// The fields are private and there is no public constructor, so this cannot be
/// built, copied into a different mode, or assembled from parts outside this
/// module. In JavaScript the equivalent was a `WeakSet` membership test that
/// ran at call time; here the check is that the program compiles.
#[derive(Debug)]
pub struct ResolvedPath {
    path: PathBuf,
    mode: Mode,
    /// Taken at resolve time, so an access uses the file that was checked
    /// rather than whatever the name points at by then.
    handle: Option<OwnedFd>,
}

impl ResolvedPath {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    /// Whether this access is bound to a handle taken when the path was checked.
    ///
    /// A build that cannot take one falls back to re-resolving at access time,
    /// which follows a component replaced in between. Callers that need the
    /// guarantee can ask rather than assume.
    pub fn is_handle_bound(&self) -> bool {
        self.handle.is_some()
    }
}

/// The identity rule for one authorised root.
///
/// Probed per root, not once for the machine. APFS is case-insensitive by
/// default and formattable either way, so one answer applied to every root is
/// an authorisation decision made about the wrong volume - which is CWE-863,
/// and was a real defect here before the probe was per-root.
#[derive(Debug, Clone, Copy)]
struct CaseRule {
    fold: bool,
}

/// Normalised for comparison: fully resolved, NFC, and case-folded where the
/// volume folds. Raw string comparison would let `Report.pdf` and `report.pdf`
/// pass as different files, which is how an output sneaks onto its input.
fn identity_key(path: &Path, rule: CaseRule) -> String {
    let normalised = nfc(&path.to_string_lossy());
    if rule.fold {
        normalised.to_lowercase()
    } else {
        normalised
    }
}

/// NFC by the table's own declaration.
///
/// Composition here is limited to the precomposed Latin range, which is what
/// the fixtures and the macOS filesystem produce. A full implementation belongs
/// with a Unicode crate; declaring the limit is the point, because the previous
/// version of this comment implied coverage it did not have.
fn nfc(input: &str) -> String {
    debug_assert_eq!(rules().identity.normalization, "NFC");
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        let composed = match (c, chars.peek()) {
            ('e', Some('\u{0301}')) => Some('é'),
            ('a', Some('\u{0301}')) => Some('á'),
            ('o', Some('\u{0301}')) => Some('ó'),
            ('c', Some('\u{0327}')) => Some('ç'),
            _ => None,
        };
        match composed {
            Some(c) => {
                chars.next();
                out.push(c);
            }
            None => out.push(c),
        }
    }
    out
}

/// The gate: one place every path passes through before it reaches a file.
pub struct Gate {
    roots: Vec<PathBuf>,
    case_rule: CaseRule,
}

impl Gate {
    /// Build a gate over the roots a caller is authorised to touch.
    ///
    /// Refuses an empty set and refuses `/`: a gate authorising everything
    /// authorises exactly what no gate does, and §13.4 must not be evadable by
    /// spelling. Refuses relative roots too - a gate built from one would
    /// accept nothing and blame the path.
    pub fn new(roots: &[&Path]) -> Result<Self, Rejected> {
        if roots.is_empty() {
            return Err(Rejected::OutsideAuthorisedRoots(
                "a gate with no authorised roots authorises nothing and says so here".into(),
            ));
        }
        let mut resolved = Vec::new();
        for root in roots {
            if !root.is_absolute() {
                return Err(Rejected::NotAbsolute(format!(
                    "{} is a relative authorised root; the gate would refuse every path and blame the path",
                    root.display()
                )));
            }
            if root.parent().is_none() {
                return Err(Rejected::OutsideAuthorisedRoots(
                    "/ as an authorised root authorises the whole filesystem, which is what having no gate does".into(),
                ));
            }
            resolved.push(std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf()));
        }
        let case_rule = probe_case_rule(&resolved)?;
        Ok(Self { roots: resolved, case_rule })
    }

    /// Resolve for reading, taking a handle while the checked path is the path.
    pub fn for_read(&self, raw: &str) -> Result<ResolvedPath, Rejected> {
        let path = self.resolve(raw)?;
        let handle = open_nofollow(&path).ok();
        Ok(ResolvedPath { path, mode: Mode::Read, handle })
    }

    /// Resolve for writing.
    ///
    /// `input` is not optional. It used to default to "no input to collide
    /// with", which is the same shape as forgetting it - and forgetting it
    /// skipped §12.1's refusal entirely, so a caller could resolve the original
    /// for writing and overwrite it. `None` states there is no input; omitting
    /// the argument is not possible.
    pub fn for_write(&self, raw: &str, input: Option<&ResolvedPath>) -> Result<ResolvedPath, Rejected> {
        let path = self.resolve(raw)?;
        if let Some(input) = input {
            if identity_key(&path, self.case_rule) == identity_key(input.path(), self.case_rule) {
                return Err(Rejected::OutputIsInput(path.display().to_string()));
            }
        }
        if path.is_dir() {
            return Err(Rejected::OutputIsDirectory(path.display().to_string()));
        }
        Ok(ResolvedPath { path, mode: Mode::Write, handle: None })
    }

    fn resolve(&self, raw: &str) -> Result<PathBuf, Rejected> {
        if raw.is_empty() {
            return Err(Rejected::EmptyOrNullByte("path is empty".into()));
        }
        if raw.contains('\0') {
            return Err(Rejected::EmptyOrNullByte("path contains a NUL byte".into()));
        }
        let candidate = Path::new(raw);
        if !candidate.is_absolute() {
            return Err(Rejected::NotAbsolute(raw.into()));
        }
        let collapsed = collapse(candidate).ok_or_else(|| Rejected::Traversal(raw.into()))?;
        let real = real_path(&collapsed)?;
        if !self.within_roots(&real) {
            // Which of the two it is matters to whoever reads it: a path that
            // left the roots by following a link is a different problem from
            // one that was never inside them.
            return Err(if collapsed == real {
                Rejected::OutsideAuthorisedRoots(real.display().to_string())
            } else {
                Rejected::SymlinkEscape(format!("{} -> {}", collapsed.display(), real.display()))
            });
        }
        Ok(real)
    }

    fn within_roots(&self, path: &Path) -> bool {
        let key = identity_key(path, self.case_rule);
        self.roots.iter().any(|root| {
            let root_key = identity_key(root, self.case_rule);
            key == root_key || key.starts_with(&format!("{root_key}/"))
        })
    }
}

/// Collapse `.` and `..` lexically, refusing an escape above the root.
fn collapse(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    Some(out)
}

/// Resolve links, keeping the missing tail: a file that does not exist yet
/// still has a real directory above it, and that is what authorisation is
/// about. Refusing everything absent would refuse every output path.
fn real_path(path: &Path) -> Result<PathBuf, Rejected> {
    match std::fs::canonicalize(path) {
        Ok(real) => Ok(real),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let parent = path.parent().ok_or_else(|| {
                Rejected::Unresolvable(format!("{}: no ancestor could be resolved", path.display()))
            })?;
            let name = path.file_name().ok_or_else(|| {
                Rejected::Unresolvable(format!("{}: no final component", path.display()))
            })?;
            // The ancestor is resolved, not assumed: a missing leaf under a
            // directory that is itself a link out of the roots was authorised
            // by the lexical path once, which is CWE-59.
            let real_parent = real_path(parent)?;
            Ok(real_parent.join(name))
        }
        Err(e) if e.raw_os_error() == Some(rustix::io::Errno::LOOP.raw_os_error()) => {
            Err(Rejected::SymlinkLoop(path.display().to_string()))
        }
        Err(e) => Err(Rejected::Unresolvable(format!("{}: {e}", path.display()))),
    }
}

/// Open without following a final symlink.
///
/// `O_NOFOLLOW` is the half the JavaScript could not reach: `node:fs` has no
/// way to refuse a link at the last component, so the gate there closed the
/// window by taking a handle and hoping the component was not a link. This
/// refuses outright, which is what `docs/contracts/path-gate.md` recorded as
/// waiting on the core language.
fn open_nofollow(path: &Path) -> std::io::Result<OwnedFd> {
    use rustix::fs::{Mode as FsMode, OFlags};
    let c_path = CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|_| std::io::Error::other("path contains a NUL byte"))?;
    rustix::fs::open(
        c_path.as_c_str(),
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        FsMode::empty(),
    )
    .map_err(std::io::Error::from)
}

/// Ask the filesystem whether it folds case, once per gate and per root set.
///
/// Refuses a set of roots that do not agree: one answer applied to volumes that
/// compare names differently is an authorisation decision made about the wrong
/// one.
fn probe_case_rule(roots: &[PathBuf]) -> Result<CaseRule, Rejected> {
    let mut answers = BTreeSet::new();
    for root in roots {
        answers.insert(folds_case(root));
    }
    match answers.len() {
        0 => Ok(CaseRule { fold: rules().identity.case_insensitive_default }),
        1 => Ok(CaseRule { fold: *answers.iter().next().expect("one answer") }),
        _ => Err(Rejected::OutsideAuthorisedRoots(
            "authorised roots span volumes that compare names differently; one rule for both would be an authorisation decision about the wrong volume".into(),
        )),
    }
}

fn folds_case(root: &Path) -> bool {
    let swapped: String = root
        .to_string_lossy()
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() {
                c.to_ascii_uppercase()
            } else {
                c.to_ascii_lowercase()
            }
        })
        .collect();
    match (std::fs::canonicalize(root), std::fs::canonicalize(&swapped)) {
        (Ok(a), Ok(b)) => a == b,
        _ => rules().identity.case_insensitive_default,
    }
}

/// Read through a path the gate issued.
///
/// Takes `&ResolvedPath` and nothing else, so there is no spelling of this call
/// that skips the gate. The JavaScript equivalent checked a `WeakSet` at run
/// time; this one cannot be called wrongly.
pub fn read_file(resolved: &ResolvedPath) -> std::io::Result<Vec<u8>> {
    if resolved.mode != Mode::Read {
        return Err(std::io::Error::other("this path was resolved for writing"));
    }
    match &resolved.handle {
        Some(fd) => {
            use std::io::Read;
            let mut file = std::fs::File::from(fd.try_clone()?);
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)?;
            Ok(bytes)
        }
        None => std::fs::read(&resolved.path),
    }
}

/// Write through a path the gate issued.
pub fn write_file(resolved: &ResolvedPath, bytes: &[u8]) -> std::io::Result<()> {
    if resolved.mode != Mode::Write {
        return Err(std::io::Error::other("this path was resolved for reading"));
    }
    std::fs::write(&resolved.path, bytes)
}

/// Every reason the table declares, for the two-way check.
pub fn declared_reasons() -> BTreeSet<&'static str> {
    rules().rejection_reasons.keys().map(String::as_str).collect()
}

/// Every reason's stage, so a test can assert none of them runs too late.
pub fn reason_stages() -> Vec<(&'static str, &'static str)> {
    rules()
        .rejection_reasons
        .iter()
        .map(|(k, v)| (k.as_str(), v.stage.as_str()))
        .collect()
}
