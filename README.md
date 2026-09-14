# BeforeShare

BeforeShare is an open-source, local-first file preflight utility for people and agents.

Before a PDF or image is emailed, uploaded, or published, BeforeShare is intended to inspect it for unintended disclosures such as metadata, hidden content, comments, ineffective redactions, location data, and visible personal information. Any supported remediation must preserve the original file, require review, create a separate sanitized copy, and verify the result.

The initial product scope is macOS with PDF, JPEG, and PNG support. The same inspection and remediation core will be exposed through a desktop application, a stable CLI, and a local MCP server.

## Status

BeforeShare is currently in the requirements and validation stage. No production implementation exists yet, and the repository must not be interpreted as claiming that files can already be made safe.

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
