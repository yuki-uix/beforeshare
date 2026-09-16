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
    let raw = path.to_string_lossy();
    // Folding first. `nfc` composes only lowercase base characters, so
    // composing first left "CAFE\u{301}.pdf" decomposed, and lowercasing it
    // afterwards produced a key the composed input never matched - an output
    // landing on its own input, which is the case §12.1 exists for.
    if rule.fold {
        nfc(&raw.to_lowercase())
    } else {
        nfc(&raw)
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
            let real = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
            // After resolution, not only before: "/." passes the check above and
            // canonicalizes to "/", so the rule was satisfiable by spelling -
            // the same way an empty root set and ["/"] were, which is why both
            // are refused rather than only one.
            if real.parent().is_none() {
                return Err(Rejected::OutsideAuthorisedRoots(format!(
                    "{} resolves to /, which authorises the whole filesystem",
                    root.display()
                )));
            }
            resolved.push(real);
        }
        let case_rule = probe_case_rule(&resolved)?;
        Ok(Self {
            roots: resolved,
            case_rule,
        })
    }

    /// Resolve for reading, taking a handle while the checked path is the path.
    pub fn for_read(&self, raw: &str) -> Result<ResolvedPath, Rejected> {
        let path = self.resolve(raw)?;
        // Not `.ok()`. A read authorisation without a handle falls back to
        // opening by name, which is the thing the handle exists to replace -
        // and the case where the open fails is the adversarial one: a link that
        // appeared at the final component after the check, which O_NOFOLLOW
        // refuses. Degrading to the name there loses the race instead of
        // refusing it.
        let handle = match open_nofollow(&path) {
            Ok(handle) => handle,
            Err(e) => return Err(open_refusal(&path, e)),
        };
        Ok(ResolvedPath {
            path,
            mode: Mode::Read,
            handle: Some(handle),
        })
    }

    /// Resolve for writing.
    ///
    /// `input` is not optional. It used to default to "no input to collide
    /// with", which is the same shape as forgetting it - and forgetting it
    /// skipped §12.1's refusal entirely, so a caller could resolve the original
    /// for writing and overwrite it. `None` states there is no input; omitting
    /// the argument is not possible.
    pub fn for_write(
        &self,
        raw: &str,
        input: Option<&ResolvedPath>,
    ) -> Result<ResolvedPath, Rejected> {
        let path = self.resolve(raw)?;
        if let Some(input) = input {
            if identity_key(&path, self.case_rule) == identity_key(input.path(), self.case_rule) {
                return Err(Rejected::OutputIsInput(path.display().to_string()));
            }
        }
        if path.is_dir() {
            return Err(Rejected::OutputIsDirectory(path.display().to_string()));
        }
        Ok(ResolvedPath {
            path,
            mode: Mode::Write,
            handle: None,
        })
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
            //
            // The test for that is whether the name given was inside a root,
            // not whether resolution changed it. `collapsed == real` said
            // "symlink escape" for /etc/passwd, because /etc is a link to
            // /private/etc on macOS - a path that was never inside anything,
            // reported as though it had broken out.
            return Err(if self.within_roots(&collapsed) {
                Rejected::SymlinkEscape(format!("{} -> {}", collapsed.display(), real.display()))
            } else {
                Rejected::OutsideAuthorisedRoots(real.display().to_string())
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
            // A dangling symlink also reports NotFound, and treating it as "a
            // file that does not exist yet" discarded the link entirely: the
            // name was rejoined to its resolved parent, so a link pointing
            // anywhere outside was authorised under its own in-root name, and
            // the write landed at the target. That is the CWE-59 the fallback
            // below claims to close, reached through the leaf instead of
            // through a directory component.
            if let Ok(meta) = std::fs::symlink_metadata(path) {
                if meta.is_symlink() {
                    let target = std::fs::read_link(path)
                        .map_err(|e| Rejected::Unresolvable(format!("{}: {e}", path.display())))?;
                    let absolute = if target.is_absolute() {
                        target
                    } else {
                        path.parent().unwrap_or(Path::new("/")).join(target)
                    };
                    let collapsed = collapse(&absolute)
                        .ok_or_else(|| Rejected::Traversal(absolute.display().to_string()))?;
                    // No self-reference check here: a link pointing at itself
                    // fails canonicalize with ELOOP below, never NotFound, so a
                    // check in this arm reads as coverage and cannot run. A
                    // mutation proved it - breaking it changed nothing.
                    return real_path(&collapsed);
                }
            }
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

/// Why a read was refused when the gate could not open it.
///
/// ELOOP here is the interesting one: `resolve` has already followed every link,
/// so a link at the final component appeared after the check. That is the race
/// O_NOFOLLOW exists to lose safely, and it is named as an escape rather than
/// reported as a filesystem hiccup.
fn open_refusal(path: &Path, e: std::io::Error) -> Rejected {
    if e.raw_os_error() == Some(rustix::io::Errno::LOOP.raw_os_error()) {
        Rejected::SymlinkEscape(format!(
            "{}: a link appeared at the final component after it was checked",
            path.display()
        ))
    } else {
        Rejected::Unresolvable(format!("{}: {e}", path.display()))
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
        answers.insert(folds_case(root)?);
    }
    decide_case_rule(&answers)
}

/// The decision, separated from the probe so it can be tested.
///
/// Two roots on volumes that compare names differently needs two volumes, which
/// no single machine reliably has - so this half is tested directly and the
/// probe half is covered by every vector that runs against a real root. Left
/// inside `probe_case_rule`, a mutation making the mixed case accepted survived
/// the whole suite.
fn decide_case_rule(answers: &BTreeSet<bool>) -> Result<CaseRule, Rejected> {
    match answers.len() {
        0 => Ok(CaseRule { fold: rules().identity.case_insensitive_default }),
        1 => Ok(CaseRule { fold: *answers.iter().next().expect("one answer") }),
        _ => Err(Rejected::OutsideAuthorisedRoots(
            "authorised roots span volumes that compare names differently; one rule for both would be an authorisation decision about the wrong volume".into(),
        )),
    }
}

fn folds_case(root: &Path) -> Result<bool, Rejected> {
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
    decide_folding(
        root,
        std::fs::canonicalize(root),
        std::fs::canonicalize(&swapped),
    )
}

/// What the two probe results mean, separated from the probing.
///
/// A machine has whatever case rule it has, so only one of these arms can ever
/// run here - and the arm that could not run was the one that was wrong. Left
/// inside the probe, a mutation restoring the permissive guess survived the
/// whole suite.
fn decide_folding(
    root: &Path,
    as_given: std::io::Result<PathBuf>,
    swapped: std::io::Result<PathBuf>,
) -> Result<bool, Rejected> {
    match (as_given, swapped) {
        // Both spellings resolve: the same file means the volume folds case.
        (Ok(a), Ok(b)) => Ok(a == b),
        // The swapped spelling does not exist. That IS the case-sensitive
        // answer, and it used to fall into the arm below and return the
        // permissive default - so on a case-sensitive volume the probe never
        // once reported the truth, and /ROOT/file counted as inside /root.
        (Ok(_), Err(ref e)) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        // The root itself cannot be resolved, or the swapped name failed for
        // some other reason. Nothing was learned; guessing here is an
        // authorisation decision made about a volume nobody asked.
        (root_answer, swapped_answer) => Err(Rejected::Unresolvable(format!(
            "{}: the case rule of this volume could not be probed ({root_answer:?} / {swapped_answer:?})",
            root.display()
        ))),
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
            use std::io::{Read, Seek};
            // try_clone duplicates the descriptor, and a duplicate shares the
            // file offset. Without this rewind a second read of the same
            // authorisation returned Ok(vec![]) - empty bytes that look like an
            // empty file rather than like a mistake.
            let mut file = std::fs::File::from(fd.try_clone()?);
            file.rewind()?;
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)?;
            Ok(bytes)
        }
        // No fallback to the name: a read authorisation always carries its
        // handle, and reopening by name is exactly the window the handle closes.
        None => Err(std::io::Error::other(
            "this read authorisation carries no handle; reopening by name would reintroduce the window it closes",
        )),
    }
}

/// Write through a path the gate issued.
pub fn write_file(resolved: &ResolvedPath, bytes: &[u8]) -> std::io::Result<()> {
    if resolved.mode != Mode::Write {
        return Err(std::io::Error::other("this path was resolved for reading"));
    }
    // Not std::fs::write: it opens by name and follows a link at the final
    // component, so a name swapped after authorisation redirects the write out
    // of the roots. This is the same defect the read side had - the handle
    // there, O_NOFOLLOW here, because a write target may not exist yet and so
    // cannot be opened at resolve time.
    use rustix::fs::{Mode as FsMode, OFlags};
    use std::io::Write;
    let c_path = CString::new(resolved.path.as_os_str().as_encoded_bytes())
        .map_err(|_| std::io::Error::other("path contains a NUL byte"))?;
    let fd = rustix::fs::open(
        c_path.as_c_str(),
        OFlags::WRONLY | OFlags::CREATE | OFlags::TRUNC | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        FsMode::from_raw_mode(0o644),
    )
    .map_err(std::io::Error::from)?;
    std::fs::File::from(fd).write_all(bytes)
}

/// Every reason the table declares, for the two-way check.
pub fn declared_reasons() -> BTreeSet<&'static str> {
    rules()
        .rejection_reasons
        .keys()
        .map(String::as_str)
        .collect()
}

/// Every reason's stage, so a test can assert none of them runs too late.
pub fn reason_stages() -> Vec<(&'static str, &'static str)> {
    rules()
        .rejection_reasons
        .iter()
        .map(|(k, v)| (k.as_str(), v.stage.as_str()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `O_NOFOLLOW` is unobservable through the public API: by the time the gate
    /// opens a path, that path is canonical, so its final component is never a
    /// link except in the race this flag exists to lose safely. Dropping the
    /// flag therefore changed nothing in any vector. Tested here instead, on the
    /// function itself.
    #[test]
    fn the_open_refuses_a_link_at_the_final_component() {
        let dir = tempfile::TempDir::new().expect("a temporary directory");
        let root = dir.path().canonicalize().expect("canonical");
        std::fs::write(root.join("real.txt"), b"x").expect("a file");
        std::os::unix::fs::symlink(root.join("real.txt"), root.join("link.txt")).expect("a link");

        assert!(
            open_nofollow(&root.join("real.txt")).is_ok(),
            "a plain file opens"
        );
        let refused = open_nofollow(&root.join("link.txt"));
        assert!(
            refused.is_err(),
            "the open followed a symlink at the final component, which is the window O_NOFOLLOW closes"
        );
    }

    /// Only one of these arms can run on any given machine, so the decision is
    /// tested apart from the probe. The arm that could not run here was the one
    /// that was wrong: a case-sensitive volume always fails to resolve the
    /// swapped spelling, and that answer was being read as "could not tell" and
    /// replaced with the permissive default - so the probe never once reported
    /// a case-sensitive volume, and /ROOT/file counted as inside /root.
    #[test]
    fn the_case_rule_is_read_from_the_volume_rather_than_guessed() {
        let root = Path::new("/somewhere");
        let missing = || std::io::Error::from(std::io::ErrorKind::NotFound);
        let denied = || std::io::Error::from(std::io::ErrorKind::PermissionDenied);

        assert!(
            decide_folding(root, Ok("/a".into()), Ok("/a".into())).expect("both resolve"),
            "two spellings of one file means the volume folds case"
        );
        assert!(
            !decide_folding(root, Ok("/a".into()), Ok("/b".into())).expect("both resolve"),
            "two different files means it does not"
        );
        assert!(
            !decide_folding(root, Ok("/a".into()), Err(missing())).expect("the root resolves"),
            "the swapped spelling naming nothing IS the case-sensitive answer"
        );
        let unprobeable =
            decide_folding(root, Err(denied()), Err(denied())).expect_err("nothing was learned");
        assert_eq!(unprobeable.reason(), "unresolvable");
        let half = decide_folding(root, Ok("/a".into()), Err(denied()))
            .expect_err("the swapped name failed for a reason that says nothing");
        assert_eq!(half.reason(), "unresolvable");
    }

    #[test]
    fn roots_on_volumes_that_disagree_are_refused() {
        let folding: BTreeSet<bool> = [true].into_iter().collect();
        let sensitive: BTreeSet<bool> = [false].into_iter().collect();
        let mixed: BTreeSet<bool> = [true, false].into_iter().collect();

        assert!(decide_case_rule(&folding).expect("one answer").fold);
        assert!(!decide_case_rule(&sensitive).expect("one answer").fold);
        let refused = decide_case_rule(&mixed).expect_err("volumes that disagree");
        assert_eq!(refused.reason(), "outside_authorised_roots");
    }

    /// With no roots there is nothing to probe, and the table's own declared
    /// default is what applies - not a guess written here.
    #[test]
    fn the_default_comes_from_the_rule_table() {
        let none = BTreeSet::new();
        assert_eq!(
            decide_case_rule(&none).expect("a default").fold,
            rules().identity.case_insensitive_default
        );
    }
}
