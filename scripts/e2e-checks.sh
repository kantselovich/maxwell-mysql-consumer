#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Do not classify infrastructure errors/timeouts as successful negative tests.
SCENARIO=smoke HARNESS_FAULT=none VERIFY_NEGATIVE=0 bash scripts/e2e.sh
SCENARIO=crud HARNESS_FAULT=missing-event VERIFY_NEGATIVE=1 bash scripts/e2e.sh
SCENARIO=crud HARNESS_FAULT=wrong-value VERIFY_NEGATIVE=1 bash scripts/e2e.sh
printf 'PASS smoke suite and both negative assertion checks\n'
