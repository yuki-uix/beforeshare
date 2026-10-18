//! Runtime defaults come from the canonical budget table.
use std::sync::OnceLock;

pub struct Limits {
    pub input_bytes: u64,
    pub wall_clock_ms: u64,
    pub worker_output_bytes: u64,
}

pub fn defaults() -> &'static Limits {
    static LIMITS: OnceLock<Limits> = OnceLock::new();
    LIMITS.get_or_init(|| {
        let rules: serde_json::Value =
            serde_json::from_str(include_str!("../../schemas/v1/limit-rules.json"))
                .expect("limit-rules.json");
        let positive = |name: &str| {
            rules["budgets"][name]["default"]
                .as_u64()
                .filter(|n| *n > 0)
                .expect("a positive integer budget")
        };
        Limits {
            input_bytes: positive("inputBytes"),
            wall_clock_ms: positive("wallClockMs"),
            worker_output_bytes: positive("workerOutputBytes"),
        }
    })
}
