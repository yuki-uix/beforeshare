//! Closed verification outcomes. Shared-parser readback can disprove removal,
//! but cannot establish an independently verified success.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    VerifiedRemoved,
    VerifiedTransformed,
    StillPresent,
    UnableToVerify,
    Failed,
}
impl Outcome {
    pub const ALL: &'static [Self] = &[
        Self::VerifiedRemoved,
        Self::VerifiedTransformed,
        Self::StillPresent,
        Self::UnableToVerify,
        Self::Failed,
    ];
    pub fn is_successful(self) -> bool {
        match self {
            Self::VerifiedRemoved | Self::VerifiedTransformed => true,
            Self::StillPresent | Self::UnableToVerify | Self::Failed => false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReaderRole {
    SharesWriterImplementation,
}

/// One action result, serializable as verification-result.schema.json's
/// actionResult. The envelope, preservation checks and independent backend are
/// deliberately not fabricated by this low-level readback.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    action: &'static str,
    outcome: Outcome,
    read_paths: Vec<ReadPath>,
    surfaces_checked: Vec<&'static str>,
    message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    unverifiable_reason: Option<&'static str>,
}
#[derive(Debug, Clone, Serialize)]
struct ReadPath {
    reader: &'static str,
    version: &'static str,
    role: ReaderRole,
    #[serde(skip_serializing_if = "Option::is_none")]
    surface: Option<&'static str>,
}
impl ActionResult {
    pub fn outcome(&self) -> Outcome {
        self.outcome
    }
    pub fn is_successful(&self) -> bool {
        self.outcome.is_successful()
    }
    pub fn unverifiable_reason(&self) -> Option<&'static str> {
        self.unverifiable_reason
    }

    pub(crate) fn metadata_readback(present: bool) -> Self {
        let mut result = Self::unavailable("no_independent_reader_for_this_action");
        if present {
            result.outcome = Outcome::StillPresent;
            result.unverifiable_reason = None;
            result.surfaces_checked = vec!["metadata_block"];
            result.read_paths[0].surface = Some("metadata_block");
            result.message =
                "A selected metadata field is still present in shared-parser readback.";
        }
        result
    }
    pub(crate) fn unavailable(reason: &'static str) -> Self {
        Self {
            action: "remove_pdf_metadata_field",
            outcome: Outcome::UnableToVerify,
            read_paths: vec![ReadPath {
                reader: "pdf.metadata_shared_readback",
                version: crate::VERSION,
                role: ReaderRole::SharesWriterImplementation,
                surface: None,
            }],
            surfaces_checked: vec![],
            message: "No independent metadata reader and preservation pipeline is available; this output is not verified.",
            unverifiable_reason: Some(reason),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    #[test]
    fn outcomes_match_the_canonical_contract_and_only_two_can_succeed() {
        let schema: serde_json::Value = serde_json::from_str(include_str!(
            "../../schemas/v1/verification-result.schema.json"
        ))
        .unwrap();
        let canonical: BTreeSet<_> = schema["$defs"]["actionResult"]["properties"]["outcome"]
            ["enum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect();
        let rust: BTreeSet<_> = Outcome::ALL
            .iter()
            .map(|outcome| {
                serde_json::to_value(outcome)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        assert_eq!(rust, canonical);
        assert_eq!(rust.len(), Outcome::ALL.len());
        for outcome in Outcome::ALL {
            assert_eq!(
                outcome.is_successful(),
                matches!(
                    outcome,
                    Outcome::VerifiedRemoved | Outcome::VerifiedTransformed
                )
            );
        }
        assert!(serde_json::from_str::<Outcome>("\"unknown\"").is_err());
    }
    #[test]
    fn a_shared_reader_may_disprove_removal_but_never_prove_it() {
        let present = ActionResult::metadata_readback(true);
        assert_eq!(present.outcome(), Outcome::StillPresent);
        assert!(!present.is_successful());
        assert!(present.unverifiable_reason().is_none());
        let absent = ActionResult::metadata_readback(false);
        assert_eq!(absent.outcome(), Outcome::UnableToVerify);
        assert!(!absent.is_successful());
        let json = serde_json::to_value(absent).unwrap();
        assert_eq!(json["readPaths"][0]["role"], "shares_writer_implementation");
        assert!(json["surfacesChecked"].as_array().unwrap().is_empty());
    }
}
