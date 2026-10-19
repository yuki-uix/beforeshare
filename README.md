# BeforeShare

BeforeShare is an open-source, local-first file preflight utility for people and agents.

Before a PDF or image is emailed, uploaded, or published, BeforeShare is intended to inspect it for unintended disclosures such as metadata, hidden content, comments, ineffective redactions, location data, and visible personal information. Any supported remediation must preserve the original file, require review, create a separate sanitized copy, and verify the result.

The initial product scope is macOS with PDF, JPEG, and PNG support. The same inspection and remediation core will be exposed through a desktop application, a stable CLI, and a local MCP server.

## Status

BeforeShare has an experimental Rust PDF inspector and a read-only CLI (`inspect`, `capabilities`, `version`). Image inspection, OCR, remediation, independent verification, desktop, and MCP are not implemented. This is not a production release and does not claim that files can be made safe.

CLI inspection enforces the canonical input-size and process-deadline budgets (currently 256 MiB and 30 seconds). `--max-input-bytes` and `--timeout-ms` may lower these limits. Oversized intake exits 4; timeout exits 5 after stopping and reaping the worker. Worker output is also capped at 16 MiB combined; exceeding it exits 5. These refusals diagnose the failure on stderr and leave stdout empty, including in JSON mode, because no complete inspection result exists. See [runtime limits and PDF boundaries](docs/contracts/runtime-inspection-limits.md).

The Rust core now binds immutable input snapshots, approvals and prepared output bytes to one session and run. CLI inspection rechecks the original pathname and hash before returning a result; a changed input exits 5 with empty stdout. See [Rust stage binding](docs/contracts/core-stage-binding.md) for the ownership guarantees and remaining output/verification work.

```sh
cargo run -p beforeshare-cli -- inspect document.pdf --json
cargo run -p beforeshare-cli -- inspect document.pdf --timeout-ms 5000
```

## Product specification

See [BeforeShare Product Case Study](docs/product-case-study.md) for the detailed requirements, evaluation design, safety gates, agent-discovery criteria, and pilot acceptance plan.

## Principles

- Local processing by default
- Originals are immutable
- Review before mutation
- Evidence-backed findings
- Independent post-remediation verification
- Explicit partial and failed states
- Desktop usability for non-technical users
- Stable CLI and MCP contracts for agents

## License

An open-source license has not yet been selected. Contributions are not being accepted until the license and contribution policy are published.
