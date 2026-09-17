//! Evidence masking (`docs/contracts/masking.md`).
//!
//! Every operation is on code points, never on bytes or UTF-16 units: masking
//! CJK text by byte produces mojibake and can still leak. The JavaScript
//! reference says the same thing in its own first comment, and the cases both
//! must answer live in `schemas/v1/masking-vectors.json` rather than in either
//! suite - a port that agreed with the prose and disagreed with the code would
//! otherwise look correct from both sides.
use std::collections::BTreeMap;

use serde::Deserialize;

const POLICY_TABLE: &str = include_str!("../../schemas/v1/evidence-policy.json");

/// The cap runs before masking, so neither the tail of a long value nor its
/// exact length leaks.
pub const MAX_DISPLAY_CODE_POINTS: usize = 64;

/// Below this many hidden code points a policy degrades rather than half-reveal.
const MIN_HIDDEN: usize = 2;

const HIDDEN: &str = "***";

/// What a value looks like once it is safe to show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Masked {
    pub display_value: String,
    /// What actually happened, which is not always what was asked for: a value
    /// too short for its policy is reported as `fully_masked`, not as the
    /// policy that could not be applied.
    pub mask_policy: String,
    pub redacted: bool,
    pub truncated: bool,
}

#[derive(Deserialize)]
struct PolicyFile {
    categories: BTreeMap<String, serde_json::Value>,
    #[serde(rename = "shownInFull", default)]
    shown_in_full: Vec<String>,
}

fn policies() -> &'static BTreeMap<String, String> {
    static CACHE: std::sync::OnceLock<BTreeMap<String, String>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| {
        let file: PolicyFile = serde_json::from_str(POLICY_TABLE).expect("evidence-policy.json");
        file.categories
            .into_iter()
            .filter(|(k, _)| !k.starts_with('$'))
            .filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string())))
            .collect()
    })
}

/// The policy this category's evidence is shown under.
///
/// Absent is a failure rather than a default: a category nobody decided about
/// would otherwise be shown under whichever policy the fallback happened to be,
/// and the safe-looking fallback is the one that hides a decision.
pub fn policy_for(category: &str) -> Option<&'static str> {
    policies().get(category).map(String::as_str)
}

/// Whether this category's own document-derived value is deliberately shown in
/// full.
///
/// The table names these and gives a reason for each. Everything else under the
/// unredacted policy is a value the detector wrote, and a document's value
/// arriving under it is refused rather than shown.
pub fn shown_in_full(category: &str) -> bool {
    static CACHE: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| {
            let file: PolicyFile =
                serde_json::from_str(POLICY_TABLE).expect("evidence-policy.json");
            file.shown_in_full
        })
        .iter()
        .any(|c| c == category)
}

/// One decimal place, rounded the way `Number.prototype.toFixed` rounds.
///
/// Not `{:.1}`, which rounds a tie to the even digit: measured, 0.25 formats as
/// 0.2 here and 0.3 in JavaScript, and -0.25 as -0.2 against -0.3. Two
/// implementations of one masking rule that disagree on a coordinate are two
/// different answers about where somebody was.
fn one_decimal(value: f64) -> String {
    let scaled = value * 10.0;
    let rounded = if scaled >= 0.0 {
        (scaled + 0.5).floor()
    } else {
        (scaled - 0.5).ceil()
    };
    format!("{:.1}", rounded / 10.0)
}

fn chars(s: &str) -> Vec<char> {
    s.chars().collect()
}

fn fully_masked(chars: &[char]) -> String {
    "*".repeat(chars.len())
}

/// Keep `keep` code points at each end, provided at least `MIN_HIDDEN` stay
/// hidden and any policy floor is met.
///
/// The general minimum follows from `keep`: showing two ends of a value leaves
/// `len - 2 * keep` hidden, and that must be at least `MIN_HIDDEN`. A policy may
/// ask for more - a token is recognisable from less - and only that extra floor
/// is passed in. It was passed for both policies at first, and the number for
/// text was the derived one: a parameter that could be changed without changing
/// anything, which is the same defect as a check that cannot fail.
///
/// The test also used to live here *and* at both call sites, where the callers'
/// was stricter, so this one could never fire.
fn keep_edges(chars: &[char], keep: usize, policy_floor: Option<usize>) -> Option<String> {
    if let Some(floor) = policy_floor {
        if chars.len() < floor {
            return None;
        }
    }
    if chars.len() < 2 * keep || chars.len() - 2 * keep < MIN_HIDDEN {
        return None;
    }
    let head: String = chars[..keep].iter().collect();
    let tail: String = chars[chars.len() - keep..].iter().collect();
    Some(format!("{head}{HIDDEN}{tail}"))
}

/// Mask a value under a policy.
pub fn mask(value: &str, policy: &str) -> Result<Masked, String> {
    let all = chars(value);
    let truncated = all.len() > MAX_DISPLAY_CODE_POINTS;
    let kept: Vec<char> = all.iter().take(MAX_DISPLAY_CODE_POINTS).copied().collect();

    // Unredacted, not unbounded: an oversized "structural" value is exactly the
    // case where a detector has mislabelled content as structure.
    if policy == "structural_label" {
        return Ok(Masked {
            display_value: kept.iter().collect(),
            mask_policy: policy.to_string(),
            redacted: false,
            truncated,
        });
    }

    let degrade = || Masked {
        display_value: fully_masked(&kept),
        mask_policy: "fully_masked".to_string(),
        redacted: true,
        truncated,
    };

    let display_value = match policy {
        "fully_masked" => fully_masked(&kept),
        "email_local_part" => {
            let Some(at) = kept.iter().rposition(|c| *c == '@') else {
                return Ok(degrade());
            };
            if at == 0 || at - 1 < MIN_HIDDEN {
                return Ok(degrade());
            }
            let domain: String = kept[at..].iter().collect();
            format!("{}{HIDDEN}{domain}", kept[0])
        }
        "digits_keep_last_4" => {
            let digits: Vec<usize> = kept
                .iter()
                .enumerate()
                .filter(|(_, c)| c.is_ascii_digit())
                .map(|(i, _)| i)
                .collect();
            if digits.len() < 4 || digits.len() - 4 < MIN_HIDDEN {
                return Ok(degrade());
            }
            let keep: std::collections::BTreeSet<usize> =
                digits[digits.len() - 4..].iter().copied().collect();
            kept.iter()
                .enumerate()
                .map(|(i, c)| {
                    if c.is_ascii_digit() && !keep.contains(&i) {
                        '*'
                    } else {
                        *c
                    }
                })
                .collect()
        }
        // The minimum is the policy's, not a consequence of MIN_HIDDEN: a
        // seven-character token would leave three hidden and still be
        // recognisable, so the token policy asks for eight.
        "token_keep_edges" => {
            let Some(out) = keep_edges(&kept, 2, Some(8)) else {
                return Ok(degrade());
            };
            out
        }
        "text_keep_edges" => {
            let Some(out) = keep_edges(&kept, 1, None) else {
                return Ok(degrade());
            };
            out
        }
        "coordinate_coarsened" => {
            // The cap runs before masking, and every other branch works on the
            // capped value. This one read the whole string, so a coordinate
            // written past the sixty-fourth code point was still parsed and
            // shown - the cap does not apply to what a policy goes and fetches
            // for itself.
            let bounded: String = kept.iter().collect();
            let numbers = numbers_in(&bounded);
            if numbers.len() < 2 {
                return Ok(degrade());
            }
            format!("{}, {}", one_decimal(numbers[0]), one_decimal(numbers[1]))
        }
        other => return Err(format!("unknown mask policy: {other}")),
    };

    if chars(&display_value).len() > MAX_DISPLAY_CODE_POINTS {
        return Ok(Masked {
            display_value: fully_masked(&kept),
            mask_policy: "fully_masked".to_string(),
            redacted: true,
            truncated,
        });
    }
    Ok(Masked {
        display_value,
        mask_policy: policy.to_string(),
        redacted: true,
        truncated,
    })
}

/// The numbers in a string, in order, the way the reference implementation's
/// `/-?\d+(\.\d+)?/g` finds them.
fn numbers_in(value: &str) -> Vec<f64> {
    let bytes: Vec<char> = value.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        let start = i;
        if bytes[i] == '-' && i + 1 < bytes.len() && bytes[i + 1].is_ascii_digit() {
            i += 1;
        }
        if !bytes[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i + 1 < bytes.len() && bytes[i] == '.' && bytes[i + 1].is_ascii_digit() {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
        }
        let text: String = bytes[start..i].iter().collect();
        if let Ok(n) = text.parse::<f64>() {
            out.push(n);
        }
    }
    out
}
