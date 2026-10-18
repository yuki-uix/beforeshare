//! `beforeshare` — the read-only half of §12.
//!
//! Three commands: `inspect`, `capabilities`, `version`. Each answers with what
//! the core already knows; none of them decides anything the core has a rule
//! for. The exit code comes from the table in `schemas/v1/exit-code-rules.json`
//! and the result from `beforeshare_core::result::assemble`, so this file is
//! argument parsing, two renderings, and the order of the steps.
//!
//! Inspection runs in a killable worker under the canonical wall-clock budget.
//! What it deliberately does not do: prompt, write a file, keep a run, or say
//! anything about a file it did not read. `sanitize` and `verify` are #72.
//!
//! §12.1 requires that JSON mode never prompts, and nothing here asserts that -
//! an absent behaviour cannot be caught by a test that watches for it. What
//! holds it is that no path in this crate reads standard input at all, which is
//! a property of the source rather than of a run.

mod clock;
mod exit;
mod render;
mod supervisor;

use std::path::Path;
use std::time::SystemTime;

use beforeshare_core::{identity, limits, path_gate, pdf, result};

use exit::Outcome;

const CAPABILITIES: &str = include_str!("../../schemas/v1/examples/capabilities.json");

const USAGE: &str = "\
beforeshare - see what a file discloses before you share it

  beforeshare inspect <path> [--json]   report what this file would disclose
  beforeshare capabilities [--json]     what this build can and cannot check
  beforeshare version [--json]          the version of the core and its rules

inspect limits (may only lower the built-in budgets):
  --max-input-bytes <n>   default 268435456 (256 MiB)
  --timeout-ms <n>        default 30000; includes file intake and parsing

Everything runs on this machine. Nothing is uploaded, and no file is modified.
";

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    // Private subprocess entry point. It runs the same validation and bounded
    // intake, while the public entry point owns the deadline and the process.
    let worker = args.first().is_some_and(|arg| arg == "--inspection-worker");
    if worker {
        args.remove(0);
    }
    let code = run(&args, worker);
    std::process::exit(code);
}

fn run(args: &[String], worker: bool) -> i32 {
    if args.len() == 1 && args[0] == "--help" {
        eprint!("{USAGE}");
        return 0;
    }
    let json = args.iter().any(|a| a == "--json");
    let mut positional = Vec::new();
    let mut input_limit = None;
    let mut timeout_ms = None;
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        match arg {
            "--json" => {}
            "--max-input-bytes" | "--timeout-ms" => {
                let (slot, ceiling) = if arg == "--max-input-bytes" {
                    (&mut input_limit, limits::defaults().input_bytes)
                } else {
                    (&mut timeout_ms, limits::defaults().wall_clock_ms)
                };
                index += 1;
                let value = args.get(index).and_then(|v| v.parse::<u64>().ok());
                match value {
                    Some(value) if value > 0 && value <= ceiling && slot.is_none() => {
                        *slot = Some(value)
                    }
                    _ => {
                        return refuse(&format!(
                            "{arg} requires one integer in 1..={ceiling} and may appear only once"
                        ))
                    }
                }
            }
            option if option.starts_with("--") => {
                return refuse(&format!("unknown option: {option}"))
            }
            _ => positional.push(arg),
        }
        index += 1;
    }
    if (input_limit.is_some() || timeout_ms.is_some()) && positional.first() != Some(&"inspect") {
        return refuse("resource limits apply only to inspect");
    }

    match positional.first().copied() {
        Some("inspect") => match positional.get(1) {
            Some(path) if positional.len() == 2 => {
                if worker {
                    supervisor::start_worker_deadline(std::time::Duration::from_millis(
                        timeout_ms.unwrap_or(limits::defaults().wall_clock_ms),
                    ));
                    inspect(
                        path,
                        json,
                        input_limit.unwrap_or(limits::defaults().input_bytes),
                    )
                } else {
                    supervised(args, timeout_ms.unwrap_or(limits::defaults().wall_clock_ms))
                }
            }
            Some(_) => refuse("inspect takes one path; it does not recurse into directories"),
            None => refuse("inspect needs a path"),
        },
        Some("capabilities") if positional.len() == 1 => capabilities(json),
        Some("version") if positional.len() == 1 => version(json),
        Some("help") | None => {
            // Not a failure, and not on stdout in JSON mode either: stdout in
            // JSON mode carries the result and nothing else.
            eprint!("{USAGE}");
            0
        }
        Some(other) => refuse(&format!("unknown command: {other}")),
    }
}

/// An argument problem: nothing was opened, nothing is on stdout.
fn refuse(message: &str) -> i32 {
    eprintln!("beforeshare: {message}");
    eprint!("{USAGE}");
    exit::code_for(&Outcome {
        invalid_arguments: true,
        ..Default::default()
    })
    .0
}

fn supervised(args: &[String], timeout_ms: u64) -> i32 {
    use std::io::Write;
    let result = std::env::current_exe().and_then(|exe| {
        supervisor::execute(
            std::process::Command::new(exe)
                .arg("--inspection-worker")
                .args(args),
            std::time::Duration::from_millis(timeout_ms),
            limits::defaults().worker_output_bytes,
        )
    });
    match result {
        Ok(supervisor::Completion::Finished {
            status,
            stdout,
            stderr,
        }) => {
            if status.code() == Some(supervisor::WATCHDOG_EXIT) {
                eprintln!("beforeshare: timeout: inspection worker exceeded its deadline; no result is available");
                return 5;
            }
            if let Some(code) = status.code() {
                // Nothing reaches stdout until a complete worker has exited.
                if std::io::stdout().write_all(&stdout).is_err()
                    || std::io::stderr().write_all(&stderr).is_err()
                {
                    return 5;
                }
                code
            } else {
                eprintln!("beforeshare: inspection worker terminated; no result is available");
                5
            }
        }
        Ok(supervisor::Completion::OutputLimitExceeded) => {
            eprintln!("beforeshare: resource_limit_exceeded: worker output exceeded its budget; worker stopped and no result is available");
            5
        }
        Ok(supervisor::Completion::TimedOut) => {
            eprintln!("beforeshare: timeout: inspection exceeded {timeout_ms} ms; worker stopped and no result is available");
            5
        }
        Err(_) => {
            eprintln!("beforeshare: inspection worker failed; no result is available");
            5
        }
    }
}

fn inspect(raw: &str, json: bool, input_limit: u64) -> i32 {
    let started = SystemTime::now();
    let clock = std::time::Instant::now();

    // The gate resolves before anything opens the file: §13.4 is about every
    // access, and the way to make that true is for the reading function to be
    // unable to take a string. The authorised root is the directory the user
    // named, so a link out of it is refused rather than followed - the user
    // asked about a file in a place, not about wherever that name points.
    //
    // A relative path is absolutised here, before the gate, because a person at
    // a prompt types `inspect draft.pdf` and the gate takes absolute paths
    // only: refusing that would be this interface declining to do the one
    // conversion it is in a position to do.
    let cwd = match std::env::current_dir() {
        Ok(dir) => dir,
        Err(e) => return refuse(&format!("cannot resolve the current directory: {e}")),
    };
    let requested = Path::new(raw);
    let absolute = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        cwd.join(requested)
    };
    let root = match absolute.parent().map(std::fs::canonicalize) {
        Some(Ok(root)) => root,
        _ => return refuse(&format!("{raw}: no such directory")),
    };
    let gate = match path_gate::Gate::new(&[root.as_path()]) {
        Ok(gate) => gate,
        Err(rejected) => return refuse(&format!("{}: {}", root.display(), rejected.reason())),
    };
    let resolved = match gate.for_read(&absolute.to_string_lossy()) {
        Ok(resolved) => resolved,
        Err(rejected) => return refuse(&format!("{raw}: {}", rejected.reason())),
    };
    let bytes = match path_gate::read_file_limited(&resolved, input_limit) {
        Ok(bytes) => bytes,
        Err(path_gate::LimitedReadError::TooLarge) => {
            eprintln!("beforeshare: input_too_large: input exceeds {input_limit} bytes; no inspection was performed");
            return exit::code_for(&Outcome {
                coverage_incomplete: true,
                ..Default::default()
            })
            .0;
        }
        Err(path_gate::LimitedReadError::Io(_)) => {
            eprintln!("beforeshare: could not read the selected file");
            return exit::code_for(&Outcome {
                processing_failure: true,
                ..Default::default()
            })
            .0;
        }
    };

    // Sniffed, not taken from the name. An extension is a claim by whoever
    // named the file, and §12.2 separates "outside what I check" from "I tried
    // and failed" - answering the first from a file's name would put a PDF with
    // the wrong suffix in the second.
    let media_type = media_type_of(&bytes);
    let inspection = if media_type == "application/pdf" {
        pdf::inspect(&bytes)
    } else {
        pdf::Inspection::nothing_read()
    };

    let facts = result::InputFacts {
        path: resolved.path().display().to_string(),
        media_type: media_type.to_string(),
        sha256: identity::sha256_hex(&bytes),
        size_bytes: bytes.len() as u64,
    };
    let run_id = clock::run_id(started, clock::entropy());
    let assembled = result::assemble(
        &inspection,
        &facts,
        &run_id,
        &clock::timestamp(started),
        clock.elapsed().as_millis() as u64,
    );
    let value = match assembled {
        Ok(value) => value,
        Err(e) => {
            // The core refused to describe this run. There is no result to put
            // on stdout, so nothing goes there.
            eprintln!("beforeshare: the result could not be assembled: {e}");
            return exit::code_for(&Outcome {
                processing_failure: true,
                ..Default::default()
            })
            .0;
        }
    };

    let status = value["status"].as_str().unwrap_or("failed");
    let outcome = Outcome {
        unsupported_media_type: status == "unsupported",
        processing_failure: status == "failed",
        // From the result rather than from a second look at the coverage: a
        // status and an exit code computed from different places are two
        // answers to one question, and #24 left exactly this to be checked
        // end to end.
        coverage_incomplete: !value["coverage"]["skipped"]
            .as_array()
            .map(|s| s.is_empty())
            .unwrap_or(true)
            || !value["coverage"]["failed"]
                .as_array()
                .map(|f| f.is_empty())
                .unwrap_or(true),
        ..Default::default()
    };
    let (code, _) = exit::code_for(&outcome);

    // A runtime assertion, not a guard: nothing can make it fail while the two
    // are computed correctly, so it counts as no coverage - the pairs the table
    // allows are checked by the end-to-end suite. It is here because the cost
    // of shipping a contradiction is a script that reads the code and sends the
    // file.
    //
    // The two answers, checked against each other before either leaves. The
    // status is computed by the core from the coverage; the code is computed
    // here from the same result. They are allowed to differ - an incomplete
    // blocking run is 4 and blocking_findings - and the pairs that are allowed
    // are in the table. A pair that is not in it means one of the two is wrong,
    // and shipping it would put a run past a script that reads the code.
    let allowed = exit::codes_for_status(status);
    if !allowed.contains(&code) {
        eprintln!(
            "beforeshare: internal error: status {status} with exit {code}, \
             which exit-code-rules.json does not allow"
        );
        return exit::code_for(&Outcome {
            processing_failure: true,
            ..Default::default()
        })
        .0;
    }
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&value).expect("serialisable")
        );
    } else {
        print!("{}", render::human(&value));
    }
    code
}

/// The declaration, published as generated rather than described again here.
fn capabilities(json: bool) -> i32 {
    let value: serde_json::Value =
        serde_json::from_str(CAPABILITIES).expect("examples/capabilities.json");
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&value).expect("serialisable")
        );
    } else {
        print!("{}", render::capabilities(&value));
    }
    0
}

fn version(json: bool) -> i32 {
    let core = env!("CARGO_PKG_VERSION");
    if json {
        println!(
            "{}",
            serde_json::json!({ "cli": core, "core": beforeshare_core::VERSION, "schemaVersion": beforeshare_core::schema_version() })
        );
    } else {
        println!("beforeshare {core} (core {})", beforeshare_core::VERSION);
    }
    0
}

/// How many bytes a PDF header may hide behind.
///
/// Readers have tolerated leading junk since forever, and real files have it: a
/// byte-order mark, a stray newline, a mail gateway's preamble. Requiring the
/// header at offset zero made the command answer "not a format I check" about a
/// document the core reads and finds disclosures in - which is the worst answer
/// available, because §6.4's agent takes it as permission to carry on sharing.
/// A thousand bytes is the conventional tolerance.
const HEADER_SEARCH_WINDOW: usize = 1024;

/// The magic bytes, for the formats the contract knows.
///
/// Anything else is named as what it is not: `application/octet-stream` is not
/// in the supported set, which is what makes the run `unsupported` rather than
/// failed.
///
/// The image signatures must be at the start - a JPEG or a PNG with anything in
/// front of it is not one - and only the PDF header is searched for, which is
/// the one the format's own readers scan for.
fn media_type_of(bytes: &[u8]) -> &'static str {
    let window = &bytes[..bytes.len().min(HEADER_SEARCH_WINDOW)];
    if window.windows(5).any(|candidate| candidate == b"%PDF-") {
        "application/pdf"
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        "image/png"
    } else {
        "application/octet-stream"
    }
}
