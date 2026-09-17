//! The default output: what a person reading a terminal needs, in the order
//! they need it.
//!
//! §6.2 and §6.3 ask for two things this has to keep: a clean result says what
//! was checked rather than "safe", and an incomplete run says so before it says
//! anything reassuring. The severity shown here is the severity in the JSON -
//! it is read from the result, not decided again.

use serde_json::Value;

pub fn human(result: &Value) -> String {
    let mut out = String::new();
    let status = result["status"].as_str().unwrap_or("failed");
    let findings = result["findings"].as_array().cloned().unwrap_or_default();
    let skipped = result["coverage"]["skipped"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let failed = result["coverage"]["failed"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let completed = result["coverage"]["completed"]
        .as_array()
        .map(|c| c.len())
        .unwrap_or(0);

    out.push_str(&format!(
        "{}\n",
        result["input"]["path"].as_str().unwrap_or("(no path)")
    ));
    out.push_str(&match status {
        "no_findings" => format!(
            "Nothing found by the {completed} checks that ran. That is not a promise the file is safe - it is what these checks looked for.\n"
        ),
        "review_required" => format!("{} finding(s) to review.\n", findings.len()),
        "blocking_findings" => format!(
            "{} finding(s), at least one of which should stop this file being shared.\n",
            findings.len()
        ),
        "partial" => format!(
            "{} finding(s), and the check was not complete: some of the file was not read.\n",
            findings.len()
        ),
        "unsupported" => format!(
            "This file is not one of the formats this build checks ({}).\n",
            result["input"]["mediaType"].as_str().unwrap_or("unknown")
        ),
        _ => "The run did not complete, so nothing here describes the file.\n".to_string(),
    });

    // What was not checked, before the findings. Someone who reads the list
    // first and stops reading has still been told the list is not everything.
    if !skipped.is_empty() || !failed.is_empty() {
        out.push_str("\nNot checked:\n");
        for entry in skipped.iter().chain(failed.iter()) {
            out.push_str(&format!(
                "  {:<22} {}\n",
                entry["detector"].as_str().unwrap_or("?"),
                entry["message"].as_str().unwrap_or("")
            ));
        }
    }

    if !findings.is_empty() {
        out.push_str("\nFindings:\n");
        for finding in &findings {
            out.push_str(&format!(
                "  {:<10} {:<24} {}\n",
                format!("[{}]", finding["severity"].as_str().unwrap_or("?")),
                finding["category"].as_str().unwrap_or("?"),
                finding["evidence"]["displayValue"].as_str().unwrap_or("")
            ));
        }
        // Only when something above it actually is masked. Saying it over a
        // list of structural facts - "this document declares an /Encrypt
        // dictionary" - would teach a reader that the sentence means nothing.
        if findings
            .iter()
            .any(|f| f["evidence"]["redacted"].as_bool().unwrap_or(false))
        {
            out.push_str("\nValues are masked. Run with --json for the full result.\n");
        }
    }
    out
}

pub fn capabilities(declaration: &Value) -> String {
    let mut out = String::new();
    let operational = &declaration["operational"];
    out.push_str(&format!(
        "{}\n\n",
        operational["summary"].as_str().unwrap_or("")
    ));
    for format in declaration["formats"].as_array().unwrap_or(&Vec::new()) {
        out.push_str(&format!(
            "{}\n",
            format["mediaType"].as_str().unwrap_or("?")
        ));
        for detector in format["detectors"].as_array().unwrap_or(&Vec::new()) {
            out.push_str(&format!(
                "  {:<22} {}\n",
                detector["id"].as_str().unwrap_or("?"),
                detector["status"].as_str().unwrap_or("?")
            ));
        }
        let limits = &format["testedLimits"];
        out.push_str(&format!(
            "  tested limits: {}\n",
            limits["reason"]
                .as_str()
                .unwrap_or(limits["status"].as_str().unwrap_or("?"))
        ));
    }
    out.push_str("\nActions:\n");
    for action in declaration["actions"].as_array().unwrap_or(&Vec::new()) {
        out.push_str(&format!(
            "  {:<38} {}\n",
            action["action"].as_str().unwrap_or("?"),
            action["status"].as_str().unwrap_or("?")
        ));
    }
    out
}
