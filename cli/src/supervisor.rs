//! Bound both the worker's lifetime and the output retained by its supervisor.
//! Nonblocking reads avoid reader threads stuck on inherited pipe descriptors.
use rustix::fs::{fcntl_getfl, fcntl_setfl, OFlags};
use rustix::process::{kill_process_group, waitid, Pid, Signal, WaitId, WaitidOptions};
use std::io::{self, Read};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub const WATCHDOG_EXIT: i32 = 124;

pub enum Completion {
    Finished {
        status: ExitStatus,
        stdout: Vec<u8>,
        stderr: Vec<u8>,
    },
    TimedOut,
    OutputLimitExceeded,
}

// The private entry point also owns a deadline: invoking it directly or killing
// the supervisor must not leave an indefinitely running parser behind. The
// internal exit code tells the parent to discard even partially written output.
pub fn start_worker_deadline(timeout: Duration) {
    thread::spawn(move || {
        thread::sleep(timeout);
        std::process::exit(WATCHDOG_EXIT);
    });
}

struct Worker {
    child: Child,
    pid: Pid,
    reaped: bool,
}

impl Worker {
    fn kill_group(&self) -> io::Result<()> {
        match kill_process_group(self.pid, Signal::Kill) {
            Ok(()) | Err(rustix::io::Errno::SRCH) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        if !self.reaped {
            // Runs on timeout, output refusal, setup/read/wait errors and unwind.
            // Kill the group before reaping its leader: its PID cannot be reused
            // for an unrelated process group while the leader is still ours.
            let _ = self.kill_group();
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

// Drain a bounded amount per turn so a flooding stdout cannot starve stderr,
// deadline checks or process-state checks. Keep at most `limit` bytes combined.
fn drain_available(
    pipe: &mut impl Read,
    bytes: &mut Vec<u8>,
    total: &mut usize,
    limit: usize,
) -> io::Result<bool> {
    let mut chunk = [0u8; 8192];
    for _ in 0..8 {
        let wanted = (limit - *total + 1).min(chunk.len());
        match pipe.read(&mut chunk[..wanted]) {
            Ok(0) => return Ok(true),
            Ok(count) => {
                *total += count;
                if *total > limit {
                    return Ok(false);
                }
                bytes.extend_from_slice(&chunk[..count]);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(false),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(false)
}

pub fn execute(
    command: &mut Command,
    timeout: Duration,
    output_limit: u64,
) -> io::Result<Completion> {
    let limit = usize::try_from(output_limit)
        .ok()
        .filter(|limit| *limit > 0 && *limit < usize::MAX)
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "invalid worker output budget")
        })?;
    let started = Instant::now();
    let child = command
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let pid = Pid::from_child(&child);
    let mut worker = Worker {
        child,
        pid,
        reaped: false,
    };
    let mut stdout = worker.child.stdout.take().expect("piped stdout");
    let mut stderr = worker.child.stderr.take().expect("piped stderr");
    fcntl_setfl(&stdout, fcntl_getfl(&stdout)? | OFlags::NONBLOCK)?;
    fcntl_setfl(&stderr, fcntl_getfl(&stderr)? | OFlags::NONBLOCK)?;
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let (mut out_eof, mut err_eof, mut exited) = (false, false, false);
    let mut total = 0;
    loop {
        if started.elapsed() >= timeout {
            return Ok(Completion::TimedOut);
        }
        if !out_eof {
            out_eof = drain_available(&mut stdout, &mut out, &mut total, limit)?;
        }
        if total > limit {
            return Ok(Completion::OutputLimitExceeded);
        }
        if !err_eof {
            err_eof = drain_available(&mut stderr, &mut err, &mut total, limit)?;
        }
        if total > limit {
            return Ok(Completion::OutputLimitExceeded);
        }
        // Peek without reaping, then stop descendants before releasing the PID.
        if !exited
            && waitid(
                WaitId::Pid(pid),
                WaitidOptions::EXITED | WaitidOptions::NOHANG | WaitidOptions::NOWAIT,
            )?
            .is_some_and(|status| status.exited() || status.killed() || status.dumped())
        {
            if let Err(error) = worker.kill_group() {
                // Darwin can refuse a group containing only an exited leader.
                // Accept that only after observing EOF on both pipes: a live
                // descendant holding either pipe must still be stopped.
                if error.kind() != io::ErrorKind::PermissionDenied {
                    return Err(error);
                }
                out_eof = drain_available(&mut stdout, &mut out, &mut total, limit)?;
                if total > limit {
                    return Ok(Completion::OutputLimitExceeded);
                }
                err_eof = drain_available(&mut stderr, &mut err, &mut total, limit)?;
                if total > limit {
                    return Ok(Completion::OutputLimitExceeded);
                }
                if !out_eof || !err_eof {
                    return Err(error);
                }
            }
            exited = true;
        }
        if exited && out_eof && err_eof {
            let status = worker.child.wait()?;
            worker.reaped = true;
            return Ok(Completion::Finished {
                status,
                stdout: out,
                stderr: err,
            });
        }
        thread::sleep(
            timeout
                .saturating_sub(started.elapsed())
                .min(Duration::from_millis(2)),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inherited_pipes_do_not_extend_the_deadline() {
        let started = Instant::now();
        let result = execute(
            Command::new("/bin/sh").args(["-c", "sleep 2 & kill -STOP $$"]),
            Duration::from_millis(50),
            1 << 20,
        )
        .unwrap();
        assert!(matches!(result, Completion::TimedOut));
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "a descendant held the pipes open past the deadline"
        );
    }

    #[test]
    fn a_stopped_process_is_killed_reaped_and_its_partial_output_discarded() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("pid");
        let started = Instant::now();
        let result = execute(
            Command::new("/bin/sh")
                .args([
                    "-c",
                    "printf '{partial'; printf '%s' $$ > \"$1\"; kill -STOP $$",
                    "worker-test",
                ])
                .arg(&pid_file),
            Duration::from_secs(1),
            1 << 20,
        )
        .unwrap();
        assert!(matches!(result, Completion::TimedOut));
        assert!(started.elapsed() < Duration::from_secs(3));
        let pid = std::fs::read_to_string(pid_file).unwrap();
        let alive = Command::new("/bin/kill")
            .args(["-0", &pid])
            .output()
            .unwrap();
        assert!(
            !alive.status.success(),
            "timed-out worker was not killed and reaped"
        );
    }

    #[test]
    fn combined_output_is_bounded_and_the_worker_is_reaped() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("pid");
        let result = execute(
            Command::new("/bin/sh")
                .args([
                    "-c",
                    "printf '%s' $$ > \"$1\"; printf 123456; printf 123456 >&2; kill -STOP $$",
                    "worker-test",
                ])
                .arg(&pid_file),
            Duration::from_secs(2),
            10,
        )
        .unwrap();
        assert!(matches!(result, Completion::OutputLimitExceeded));
        let pid = std::fs::read_to_string(pid_file).unwrap();
        assert!(!Command::new("/bin/kill")
            .args(["-0", &pid])
            .output()
            .unwrap()
            .status
            .success());
    }

    #[test]
    fn exact_output_limit_preserves_both_streams() {
        let result = execute(
            Command::new("/bin/sh").args(["-c", "printf 123456; printf 1234 >&2"]),
            Duration::from_secs(2),
            10,
        )
        .unwrap();
        let Completion::Finished {
            status,
            stdout,
            stderr,
        } = result
        else {
            panic!("exact limit refused")
        };
        assert!(status.success());
        assert_eq!(stdout, b"123456");
        assert_eq!(stderr, b"1234");
    }

    #[test]
    fn exited_leaders_do_not_leave_descendants_holding_pipes() {
        let started = Instant::now();
        let result = execute(
            Command::new("/bin/sh").args(["-c", "sleep 2 & printf done"]),
            Duration::from_secs(1),
            100,
        )
        .unwrap();
        let Completion::Finished { status, stdout, .. } = result else {
            panic!("inherited pipes blocked completion")
        };
        assert!(status.success());
        assert_eq!(stdout, b"done");
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn both_pipes_are_drained_without_deadlock() {
        let result = execute(Command::new("/bin/sh").args(["-c", "i=0; while [ $i -lt 20000 ]; do printf 'stdout line\n'; printf 'stderr line\n' >&2; i=$((i+1)); done"]), Duration::from_secs(10), 1 << 20).unwrap();
        let Completion::Finished {
            status,
            stdout,
            stderr,
        } = result
        else {
            panic!("timed out")
        };
        assert!(status.success());
        assert_eq!(stdout.len(), 240000);
        assert_eq!(stderr.len(), 240000);
    }
}
