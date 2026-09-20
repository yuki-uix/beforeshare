//! The two things the core refuses to invent: when the run started, and which
//! run it was.
//!
//! `assemble` takes both from its caller on purpose - a core with its own clock
//! would make two runs over the same bytes differ for a reason nobody chose -
//! so supplying them is the interface's job.

use std::time::{SystemTime, UNIX_EPOCH};

/// RFC 3339 in UTC, which is the format `common.schema.json` requires.
pub fn timestamp(now: SystemTime) -> String {
    let secs = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (year, month, day, hour, minute, second) = civil_from_unix(secs);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Days since the epoch to a civil date, by Howard Hinnant's algorithm.
///
/// Written out rather than pulled in: a date library is a dependency for one
/// formatting decision, and this has vectors below that a wrong answer fails.
fn civil_from_unix(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if m <= 2 { y + 1 } else { y };
    (
        year,
        m,
        d,
        (rem / 3600) as u32,
        ((rem % 3600) / 60) as u32,
        (rem % 60) as u32,
    )
}

/// A ULID-shaped identifier: 48 bits of millisecond time, then 80 bits of
/// randomness, in Crockford's base32.
///
/// `common.schema.json` says it is locally generated, unique per run on this
/// device, and never derived from the file's contents or its path - so this
/// takes nothing from the input. Two runs of the same bytes get different
/// identifiers, which is the point: they are different runs.
pub fn run_id(now: SystemTime, entropy: u128) -> String {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let millis = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
        & ((1u128 << 48) - 1);
    let value = (millis << 80) | (entropy & ((1u128 << 80) - 1));
    let mut out = [b'0'; 26];
    for (index, slot) in out.iter_mut().enumerate() {
        let shift = 125 - index * 5;
        *slot = ALPHABET[((value >> shift) & 0b11111) as usize];
    }
    String::from_utf8(out.to_vec()).expect("base32 is ASCII")
}

/// Randomness from the standard library's hasher, which the operating system
/// seeds. No dependency, and nothing here reads the input.
pub fn entropy() -> u128 {
    use std::hash::{BuildHasher, Hasher};
    let hash = |seed: u8| {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u8(seed);
        hasher.finish() as u128
    };
    (hash(1) << 64) | hash(2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn at(secs: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(secs)
    }

    #[test]
    fn known_instants() {
        assert_eq!(timestamp(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(timestamp(at(1_000_000_000)), "2001-09-09T01:46:40Z");
        // A leap day, which is where a hand-written calendar goes wrong.
        assert_eq!(timestamp(at(1_709_164_800)), "2024-02-29T00:00:00Z");
        assert_eq!(timestamp(at(1_735_689_599)), "2024-12-31T23:59:59Z");
    }

    #[test]
    fn a_run_id_is_the_shape_the_schema_requires() {
        let id = run_id(at(1_700_000_000), 12345);
        assert_eq!(id.len(), 26);
        assert!(
            id.chars()
                .all(|c| "0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(c)),
            "{id}"
        );
    }

    /// The identifier says when, and says nothing about what was read.
    #[test]
    fn two_runs_at_the_same_instant_differ() {
        let now = at(1_700_000_000);
        assert_ne!(run_id(now, entropy()), run_id(now, entropy()));
    }
}
