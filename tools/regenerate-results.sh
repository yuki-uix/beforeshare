#!/usr/bin/env bash
# The committed results are a function of the core, and the suite that validates
# them reads the files in the tree. Without this, a change that made the core
# emit something else passed as long as nobody regenerated - the suite was
# reading last week's output.
#
# One script, called by `npm test` and by CI, because the check existed in CI
# only and a local run could be green on stale results.
#
# Separate from `test:results`, which regenerates and then validates. Putting
# both in one place made every mutation that changes what the core emits fail
# here first, so the suite the mutation was aimed at never ran.
set -euo pipefail

cd "$(dirname "$0")/.."
cargo run -q --manifest-path core/Cargo.toml --example emit-results > /dev/null

if ! git diff --exit-code HEAD -- fixtures/pdf/results ||
   [[ -n "$(git ls-files --others -- fixtures/pdf/results)" ]]; then
  echo "::error::the committed results differ from what this core emits - regenerate with: npm run results:regenerate" >&2
  exit 1
fi
