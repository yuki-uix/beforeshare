//! §12.2's exit codes, read from the table both implementations share.
//!
//! The order the conditions are checked in decides what a run with two of them
//! reports, so it is not restated here: `schemas/v1/exit-code-rules.json` has
//! it, `tools/exit-codes.mjs` walks it, and so does this.

const RULES: &str = include_str!("../../schemas/v1/exit-code-rules.json");

/// What happened during the run, in the vocabulary the table uses.
///
/// Every field is a condition the table names. A condition this build cannot
/// produce yet - an output path, an approval - is still here and still false,
/// because the order only means something if the whole order is present.
#[derive(Debug, Default, Clone, Copy)]
pub struct Outcome {
    pub invalid_arguments: bool,
    pub unsafe_output_path: bool,
    pub approval_required: bool,
    pub unsupported_media_type: bool,
    pub processing_failure: bool,
    pub verification_failure: bool,
    pub coverage_incomplete: bool,
}

impl Outcome {
    fn holds(&self, condition: &str) -> bool {
        match condition {
            "invalidArguments" => self.invalid_arguments,
            "unsafeOutputPath" => self.unsafe_output_path,
            "approvalRequired" => self.approval_required,
            "unsupportedMediaType" => self.unsupported_media_type,
            "processingFailure" => self.processing_failure,
            "verificationFailure" => self.verification_failure,
            "coverageIncomplete" => self.coverage_incomplete,
            // A condition in the table that this does not answer would be
            // skipped silently, and the run would exit by whichever later
            // condition happened to hold. The table is the contract; not
            // knowing a row is a defect here, not a default there.
            other => {
                panic!("the exit-code table names a condition this build does not answer: {other}")
            }
        }
    }
}

/// The code and the sentence that goes with it.
pub fn code_for(outcome: &Outcome) -> (i32, String) {
    let rules: serde_json::Value = serde_json::from_str(RULES).expect("exit-code-rules.json");
    let codes = &rules["codes"];
    for row in rules["order"].as_array().expect("an ordered table") {
        let condition = row["condition"].as_str().expect("a condition name");
        if outcome.holds(condition) {
            let name = row["code"].as_str().expect("a code name");
            return (
                codes[name].as_i64().expect("a number") as i32,
                row["reason"].as_str().unwrap_or_default().to_string(),
            );
        }
    }
    let fallback = &rules["default"];
    let name = fallback["code"].as_str().expect("a code name");
    (
        codes[name].as_i64().expect("a number") as i32,
        fallback["reason"].as_str().unwrap_or_default().to_string(),
    )
}

/// Which codes a status may appear with, for the test that checks this build
/// against the same table.
pub fn codes_for_status(status: &str) -> Vec<i32> {
    let rules: serde_json::Value = serde_json::from_str(RULES).expect("exit-code-rules.json");
    let codes = rules["codes"].clone();
    rules["statusExitMatrix"][status]
        .as_array()
        .map(|names| {
            names
                .iter()
                .filter_map(|n| n.as_str())
                .filter_map(|n| codes[n].as_i64())
                .map(|c| c as i32)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_complete_clean_run_exits_zero() {
        assert_eq!(code_for(&Outcome::default()).0, 0);
    }

    /// The order, not the set. Two conditions at once is the case a second
    /// implementation gets wrong by restating the chain in a different order.
    #[test]
    fn the_first_condition_in_the_table_wins() {
        let outcome = Outcome {
            unsupported_media_type: true,
            coverage_incomplete: true,
            ..Default::default()
        };
        assert_eq!(code_for(&outcome).0, 3, "coverage outranked the media type");

        let outcome = Outcome {
            invalid_arguments: true,
            processing_failure: true,
            ..Default::default()
        };
        assert_eq!(code_for(&outcome).0, 2);
    }

    /// §12.2: severity is communicated in the result, never in the code. A
    /// script that reads `beforeshare inspect f.pdf && send f.pdf` as a safety
    /// gate is reading something this contract does not say.
    #[test]
    fn a_blocking_finding_does_not_change_the_code() {
        assert_eq!(codes_for_status("blocking_findings"), vec![0, 4]);
        assert_eq!(codes_for_status("review_required"), vec![0]);
    }
}
