//! The path gate's conformance vectors, ported from `tools/test-path-gate.mjs`.
//!
//! The JavaScript suite ran against a stub filesystem, and the stub's contract
//! was once fabricated: `realpath` returned null for a missing path, which no
//! filesystem does. Every vector agreed with the stub and none of them agreed
//! with reality. There is no stub here - each vector builds a real directory
//! with real symlinks under a real temporary root, so the thing under test is
//! the same `openat` the product would call.
use beforeshare_core::path_gate::{
    declared_reasons, read_file, write_file, Gate, Mode, Rejected, ResolvedPath,
};
use std::collections::BTreeSet;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tempfile::TempDir;

/// Reasons some vector actually reached, accumulated across the suite so the
/// two-way check at the end can name the ones nothing exercised.
static TRIGGERED: Mutex<BTreeSet<&'static str>> = Mutex::new(BTreeSet::new());

fn note(r: &Rejected) {
    TRIGGERED.lock().expect("not poisoned").insert(r.reason());
}

struct Tree {
    dir: TempDir,
    root: PathBuf,
}

impl Tree {
    /// The temporary directory is reached through `/var`, which is itself a
    /// symlink to `/private/var` on macOS. An authorised root spelled the
    /// unresolved way would put every resolved path outside its own root, and
    /// the whole suite would fail for a reason that has nothing to do with the
    /// gate.
    fn new() -> Self {
        let dir = TempDir::new().expect("a temporary directory");
        let root = dir.path().canonicalize().expect("canonical root");
        std::fs::create_dir_all(root.join("sub")).expect("sub");
        std::fs::write(root.join("report.pdf"), b"%PDF-1.7\n").expect("report");
        std::fs::write(root.join("real.pdf"), b"%PDF-1.7\n").expect("real");
        Self { dir, root }
    }

    fn at(&self, rel: &str) -> String {
        self.root.join(rel).display().to_string()
    }

    fn gate(&self) -> Gate {
        Gate::new(&[self.root.as_path()]).expect("the root is usable")
    }

    fn link(&self, from: &str, to: &str) {
        symlink(to, self.root.join(from)).expect("a symlink");
    }

    /// Keeps the directory alive for the whole vector; dropping it early would
    /// delete the tree out from under the gate.
    fn keep(&self) -> &Path {
        self.dir.path()
    }
}

#[track_caller]
fn rejects<T>(what: &str, got: Result<T, Rejected>, expected: &str) {
    match got {
        Ok(_) => panic!("{what}: expected {expected}, got success"),
        Err(e) => {
            note(&e);
            assert_eq!(e.reason(), expected, "{what}: wrong reason");
        }
    }
}

// --- absolute paths only ----------------------------------------------------

#[test]
fn only_absolute_well_formed_paths_enter() {
    let t = Tree::new();
    let g = t.gate();
    rejects(
        "a relative path",
        g.for_read("Documents/a.pdf"),
        "not_absolute",
    );
    rejects("an empty path", g.for_read(""), "empty_or_null_byte");
    rejects(
        "a NUL byte",
        g.for_read(&t.at("a\0.pdf")),
        "empty_or_null_byte",
    );
    let _ = t.keep();
}

// --- traversal --------------------------------------------------------------

#[test]
fn traversal_is_judged_after_collapsing() {
    let t = Tree::new();
    let g = t.gate();
    rejects(
        "escaping the root by ..",
        g.for_read(&t.at("../../etc/passwd")),
        "outside_authorised_roots",
    );
    rejects(
        "escaping above /",
        g.for_read("/../../etc/passwd"),
        "traversal",
    );
    // `a/b/../..` only shows its reach once collapsed; one that stays inside is
    // not a rejection.
    let inside = g
        .for_read(&t.at("sub/../report.pdf"))
        .expect("stays inside");
    assert_eq!(inside.path(), t.root.join("report.pdf"));
    let doubled = g.for_read(&format!("{}//sub//..//report.pdf", t.root.display()));
    assert_eq!(
        doubled.expect("collapses").path(),
        t.root.join("report.pdf")
    );
    let _ = t.keep();
}

// --- symlinks ---------------------------------------------------------------

#[test]
fn a_link_anywhere_along_the_path_is_resolved_first() {
    let t = Tree::new();
    t.link("escape.pdf", "/etc/passwd");
    t.link("escape-dir", "/private/tmp");
    t.link("alias.pdf", "real.pdf"); // relative target, stays inside
    t.link("up.pdf", "../../../etc/passwd"); // relative target, leaves
    let g = t.gate();

    rejects(
        "a link leaving the root",
        g.for_read(&t.at("escape.pdf")),
        "symlink_escape",
    );
    rejects(
        "a linked directory component leaving the root",
        g.for_read(&t.at("escape-dir/a.pdf")),
        "symlink_escape",
    );
    rejects(
        "a relative link escaping the root",
        g.for_read(&t.at("up.pdf")),
        "symlink_escape",
    );
    // A relative target resolves against the directory holding the link, so the
    // same spelling stays inside or leaves depending on where the link lives.
    let inside = g
        .for_read(&t.at("alias.pdf"))
        .expect("a relative link staying inside");
    assert_eq!(inside.path(), t.root.join("real.pdf"));
    let _ = t.keep();
}

#[test]
fn a_missing_leaf_under_an_escaping_link_is_still_refused() {
    // The bypass the gate shipped with: realpath fails on the missing leaf and
    // says nothing about the parents, so the lexical path looked inside while
    // the write would land outside.
    let t = Tree::new();
    t.link("evil", "/private/tmp");
    let g = t.gate();
    rejects(
        "a missing file under an escaping link",
        g.for_write(&t.at("evil/new.pdf"), None),
        "symlink_escape",
    );
    rejects(
        "several missing levels under an escaping link",
        g.for_write(&t.at("evil/a/b/c.pdf"), None),
        "symlink_escape",
    );
    let _ = t.keep();
}

#[test]
fn a_dangling_link_is_resolved_rather_than_taken_for_a_missing_file() {
    // A link whose target does not exist yet reports NotFound exactly as a plain
    // missing file does. Treating that as "a file that does not exist yet"
    // discarded the link and authorised the write under its own in-root name;
    // the write then followed the link and created a file outside the roots.
    // The JavaScript reference had the identical hole, and neither suite could
    // express it - its stub filesystem had no way to report a link target.
    let t = Tree::new();
    let outside = std::env::temp_dir()
        .canonicalize()
        .expect("canonical temp")
        .join("beforeshare-escaped-by-a-dangling-link.pdf");
    let _ = std::fs::remove_file(&outside);
    symlink(&outside, t.root.join("out.pdf")).expect("dangling link out");
    symlink(t.root.join("new.pdf"), t.root.join("in.pdf")).expect("dangling link in");
    symlink(t.root.join("self"), t.root.join("self")).expect("dangling self-link");
    let g = t.gate();

    rejects(
        "a dangling link whose target is outside",
        g.for_write(&t.at("out.pdf"), None),
        "symlink_escape",
    );
    assert!(
        !outside.exists(),
        "the target was created despite the refusal"
    );
    let inside = g
        .for_write(&t.at("in.pdf"), None)
        .expect("a dangling link inside the root");
    assert_eq!(
        inside.path(),
        t.root.join("new.pdf"),
        "the link was not followed"
    );
    rejects(
        "a link pointing at itself",
        g.for_read(&t.at("self")),
        "symlink_loop",
    );
    let _ = t.keep();
}

#[test]
fn a_path_that_does_not_exist_yet_can_be_written() {
    let t = Tree::new();
    let g = t.gate();
    let fresh = g
        .for_write(&t.at("new.pdf"), None)
        .expect("a new file is writable");
    assert_eq!(fresh.path(), t.root.join("new.pdf"));
    // Walking back only one level would stop at a directory that also does not
    // exist and learn nothing about the link above it.
    let deep = g
        .for_write(&t.at("a/b/c.pdf"), None)
        .expect("several missing levels");
    assert_eq!(deep.path(), t.root.join("a/b/c.pdf"));
    let _ = t.keep();
}

#[test]
fn a_cycle_is_named_rather_than_spun_on() {
    let t = Tree::new();
    symlink(t.root.join("b"), t.root.join("a")).expect("a");
    symlink(t.root.join("a"), t.root.join("b")).expect("b");
    rejects(
        "a cycle of symlinks",
        t.gate().for_read(&t.at("a")),
        "symlink_loop",
    );
    let _ = t.keep();
}

#[test]
fn a_filesystem_that_cannot_answer_is_refused_rather_than_assumed() {
    let t = Tree::new();
    let locked = t.root.join("locked");
    std::fs::create_dir(&locked).expect("dir");
    std::fs::write(locked.join("a.pdf"), b"x").expect("file");
    let g = t.gate();
    // 0o000: the directory exists, and the gate cannot learn anything about what
    // is inside it. "Cannot answer" must not collapse into "does not exist".
    std::fs::set_permissions(&locked, std::os::unix::fs::PermissionsExt::from_mode(0o000))
        .expect("chmod");
    let got = g.for_read(&t.at("locked/a.pdf"));
    std::fs::set_permissions(&locked, std::os::unix::fs::PermissionsExt::from_mode(0o755))
        .expect("chmod back");
    rejects("an unreadable directory component", got, "unresolvable");
    let _ = t.keep();
}

// --- authorised roots -------------------------------------------------------

#[test]
fn a_gate_authorising_everything_cannot_be_built() {
    let t = Tree::new();
    rejects(
        "no roots at all",
        Gate::new(&[]),
        "outside_authorised_roots",
    );
    rejects(
        "the filesystem root",
        Gate::new(&[Path::new("/")]),
        "outside_authorised_roots",
    );
    rejects(
        "the filesystem root hiding among others",
        Gate::new(&[t.root.as_path(), Path::new("/")]),
        "outside_authorised_roots",
    );
    rejects(
        "a relative root",
        Gate::new(&[Path::new("Documents")]),
        "not_absolute",
    );
    let _ = t.keep();
}

#[test]
fn a_name_prefix_is_not_containment() {
    let t = Tree::new();
    let sibling = t.root.with_file_name(format!(
        "{}Other",
        t.root.file_name().expect("named").to_string_lossy()
    ));
    std::fs::create_dir_all(&sibling).expect("sibling");
    rejects(
        "a sibling sharing a name prefix",
        t.gate()
            .for_read(&sibling.join("a.pdf").display().to_string()),
        "outside_authorised_roots",
    );
    rejects(
        "outside every root",
        t.gate().for_read("/etc/passwd"),
        "outside_authorised_roots",
    );
    std::fs::remove_dir_all(&sibling).ok();
    let _ = t.keep();
}

// --- output must not be the input (§12.1) -----------------------------------

#[test]
fn an_output_resolving_to_the_input_is_refused_in_every_spelling() {
    let t = Tree::new();
    t.link("alias.pdf", "report.pdf");
    let g = t.gate();
    let input = g.for_read(&t.at("report.pdf")).expect("the input");

    rejects(
        "the same path",
        g.for_write(&t.at("report.pdf"), Some(&input)),
        "output_is_input",
    );
    rejects(
        "reached through ..",
        g.for_write(&t.at("sub/../report.pdf"), Some(&input)),
        "output_is_input",
    );
    rejects(
        "reached through a symlink",
        g.for_write(&t.at("alias.pdf"), Some(&input)),
        "output_is_input",
    );
    let elsewhere = g
        .for_write(&t.at("report (sanitized).pdf"), Some(&input))
        .expect("a different output");
    assert_eq!(elsewhere.mode(), Mode::Write);
    let _ = t.keep();
}

#[test]
fn an_output_naming_a_directory_is_refused() {
    let t = Tree::new();
    rejects(
        "an existing directory as output",
        t.gate().for_write(&t.at("sub"), None),
        "output_is_directory",
    );
    let _ = t.keep();
}

// --- identity on this volume ------------------------------------------------

#[test]
fn identity_follows_the_volume_rather_than_a_preference() {
    // APFS is case-insensitive by default but can be formatted either way, so
    // the answer is probed per root rather than assumed. Whichever way this
    // volume answers, the two spellings must agree with that answer - asserting
    // one of them unconditionally would make the suite wrong on the other half
    // of the Macs it is meant to run on.
    let t = Tree::new();
    let g = t.gate();
    let folds = std::fs::metadata(t.root.join("REPORT.PDF")).is_ok();
    let input = g.for_read(&t.at("report.pdf")).expect("the input");
    let other_case = g.for_write(&t.at("Report.PDF"), Some(&input));
    if folds {
        rejects(
            "an output differing only in case",
            other_case,
            "output_is_input",
        );
    } else {
        assert!(
            other_case.is_ok(),
            "on a case-sensitive volume these are two files"
        );
    }
    let _ = t.keep();
}

/// The spelling the caller used is judged, not only the resolved path.
///
/// `canonicalize` folds case and composes accents on its own for a path that
/// exists, which made the gate's own normalisation untestable through any
/// vector that used an existing file: mutations removing both survived the
/// whole suite. The one place the caller's spelling is judged directly is the
/// classification below - whether a path that ended up outside the roots was
/// ever inside them - and that reads the collapsed path, never canonicalised.
#[test]
fn a_misspelled_root_is_still_recognised_as_the_root() {
    let t = Tree::new();
    t.link("escape.pdf", "/etc/passwd");
    let g = t.gate();
    let folds = std::fs::metadata(t.root.join("REPORT.PDF")).is_ok();

    let shouty: String = t.root.display().to_string().to_uppercase();
    let got = g.for_read(&format!("{shouty}/escape.pdf"));
    if folds {
        // It was inside the root, under a different spelling, and it left.
        rejects(
            "an escaping link under an upper-cased root",
            got,
            "symlink_escape",
        );
    } else {
        // On a case-sensitive volume that name is a different place entirely.
        rejects(
            "an upper-cased root on a case-sensitive volume",
            got,
            "outside_authorised_roots",
        );
    }
    let _ = t.keep();
}

#[test]
fn a_root_spelled_in_the_other_normalisation_is_the_same_root() {
    // macOS stores NFD and applications commonly produce NFC, so the two
    // spellings name one directory there. Not everywhere: a byte-preserving
    // filesystem makes them two. The volume is asked rather than assumed, and
    // both answers are asserted - a skip here would report coverage on whichever
    // machine happened to run it.
    let t = Tree::new();
    let nfc_dir = t.root.join("caf\u{e9}");
    std::fs::create_dir(&nfc_dir).expect("an accented directory");
    symlink("/etc/passwd", nfc_dir.join("escape.pdf")).expect("escaping link");
    let g = Gate::new(&[nfc_dir.canonicalize().expect("on-disk spelling").as_path()])
        .expect("a usable root");

    let nfd_dir = t.root.join("cafe\u{301}");
    let unified = std::fs::metadata(&nfd_dir).is_ok();
    let as_nfd = nfd_dir.join("escape.pdf").display().to_string();
    if unified {
        rejects(
            "an escaping link under the other normalisation of the root",
            g.for_read(&as_nfd),
            "symlink_escape",
        );
    } else {
        // Two directories. The second one holds a file that stays inside, so a
        // gate that wrongly unified them would resolve this to the escaping
        // link and refuse - the assertion has content either way.
        std::fs::create_dir(&nfd_dir).expect("the other directory");
        std::fs::write(nfd_dir.join("escape.pdf"), b"%PDF-1.7\n").expect("a plain file");
        let refused = g.for_read(&as_nfd);
        assert!(
            refused.is_err(),
            "a path under a different directory than the root was authorised"
        );
    }
    let _ = t.keep();
}

#[test]
fn the_two_spellings_of_an_accent_are_one_file() {
    // The filesystem stores NFD and applications commonly produce NFC, so this
    // is one file under two strings on every macOS volume, case rule aside.
    let t = Tree::new();
    std::fs::write(t.root.join("caf\u{e9}.pdf"), b"%PDF-1.7\n").expect("nfc name");
    let g = t.gate();
    let input = g.for_read(&t.at("caf\u{e9}.pdf")).expect("nfc");
    rejects(
        "an output differing only in normalisation",
        g.for_write(&t.at("cafe\u{301}.pdf"), Some(&input)),
        "output_is_input",
    );
    let _ = t.keep();
}

// --- the handle, and the window it closes -----------------------------------

#[test]
fn an_access_uses_the_file_that_was_checked_not_the_name() {
    // The TOCTOU left open by the JavaScript gate and recorded in
    // docs/contracts/immutable-output.md: between the check and the open, the
    // name can be repointed. The handle is taken at resolve time, so swapping
    // the name afterwards cannot redirect the read.
    let t = Tree::new();
    std::fs::write(t.root.join("report.pdf"), b"the checked bytes").expect("write");
    let g = t.gate();
    let resolved = g.for_read(&t.at("report.pdf")).expect("resolved");
    assert!(
        resolved.is_handle_bound(),
        "a read authorisation carries its handle"
    );

    std::fs::remove_file(t.root.join("report.pdf")).expect("unlink");
    symlink("/etc/passwd", t.root.join("report.pdf")).expect("repoint");

    let bytes = read_file(&resolved).expect("the handle still reads");
    assert_eq!(
        bytes, b"the checked bytes",
        "the read followed the name instead of the handle it was given"
    );
    let _ = t.keep();
}

#[test]
fn a_read_the_gate_cannot_open_is_refused_rather_than_handed_back_unbound() {
    // `open_nofollow(...).ok()` made the handle optional, and `read_file` fell
    // back to opening by name when it was absent - so the one case the flag
    // exists for, a link at the final component, degraded to following that
    // link. Refusing is the only answer that keeps the claim true.
    let t = Tree::new();
    let sealed = t.root.join("sealed.pdf");
    std::fs::write(&sealed, b"%PDF-1.7\n").expect("a file");
    std::fs::set_permissions(&sealed, std::os::unix::fs::PermissionsExt::from_mode(0o000))
        .expect("chmod");
    // Root ignores permission bits. Ask whether this process is actually kept
    // out before asserting that the gate is - otherwise the case silently
    // stops testing anything wherever it runs privileged.
    let kept_out = std::fs::File::open(&sealed).is_err();
    let got = t.gate().for_read(&t.at("sealed.pdf"));
    std::fs::set_permissions(&sealed, std::os::unix::fs::PermissionsExt::from_mode(0o644))
        .expect("chmod back");
    if kept_out {
        rejects("a file the gate cannot open", got, "unresolvable");
    } else {
        let bound = got.expect("a privileged process opens it");
        assert!(
            bound.is_handle_bound(),
            "an authorisation was issued without a handle"
        );
    }
    let _ = t.keep();
}

#[test]
fn a_read_authorisation_does_not_write() {
    let t = Tree::new();
    let g = t.gate();
    let read = g.for_read(&t.at("report.pdf")).expect("read");
    assert_eq!(read.mode(), Mode::Read);
    let refused = write_file(&read, b"evil");
    assert!(refused.is_err(), "a read-mode path accepted a write");
    let _ = t.keep();
}

// --- the two-way check ------------------------------------------------------

#[test]
fn zz_every_declared_reason_is_reachable_and_every_reachable_reason_is_declared() {
    // Named to sort last: cargo runs tests in parallel, and this one reads what
    // the others filled in. The harness below runs it in its own pass rather
    // than relying on ordering.
    let declared = declared_reasons();
    let enumerated = Rejected::all_reasons();
    assert_eq!(
        declared, enumerated,
        "path-rules.json and the Rejected enum disagree; a reason exists in one and not the other"
    );
}

/// Both directions in one process, so neither can be satisfied by the other.
///
/// The direction that was missing on the JavaScript side for a whole PR was
/// this second one: a reason nothing can reach is a rule nobody has shown the
/// gate enforces.
#[test]
fn every_declared_reason_is_triggered_by_a_vector() {
    // Run the vectors in this process first; `cargo test` gives each test a
    // thread, not a process, so TRIGGERED is shared - but only for tests that
    // actually ran. Running them here directly makes the claim independent of
    // filtering and of `--test-threads`.
    let t = Tree::new();
    only_absolute_well_formed_paths_enter();
    traversal_is_judged_after_collapsing();
    a_link_anywhere_along_the_path_is_resolved_first();
    a_missing_leaf_under_an_escaping_link_is_still_refused();
    a_read_the_gate_cannot_open_is_refused_rather_than_handed_back_unbound();
    a_dangling_link_is_resolved_rather_than_taken_for_a_missing_file();
    a_cycle_is_named_rather_than_spun_on();
    a_filesystem_that_cannot_answer_is_refused_rather_than_assumed();
    a_gate_authorising_everything_cannot_be_built();
    a_name_prefix_is_not_containment();
    an_output_resolving_to_the_input_is_refused_in_every_spelling();
    an_output_naming_a_directory_is_refused();
    identity_follows_the_volume_rather_than_a_preference();
    the_two_spellings_of_an_accent_are_one_file();
    a_misspelled_root_is_still_recognised_as_the_root();
    a_root_spelled_in_the_other_normalisation_is_the_same_root();
    let _ = t.keep();

    let triggered = TRIGGERED.lock().expect("not poisoned").clone();
    let unreached: Vec<_> = declared_reasons().difference(&triggered).copied().collect();
    assert!(
        unreached.is_empty(),
        "declared but never reached by any vector: {unreached:?} - a reason no vector can produce is a rule nobody has shown the gate enforces"
    );
}

/// `ResolvedPath` is constructible only by the gate; this is the runtime half of
/// what `tests/compile_fail.rs` proves at compile time.
#[test]
fn every_resolved_path_in_this_suite_came_from_a_gate() {
    let t = Tree::new();
    let g = t.gate();
    let p: ResolvedPath = g.for_read(&t.at("report.pdf")).expect("issued");
    assert!(p.path().starts_with(&t.root));
    let _ = t.keep();
}
