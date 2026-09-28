#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
suite_path="$PWD/artifacts/maxwell-phase5-suite-$(date +%s)-$$"
mkdir -p "$suite_path"
export ARTIFACT_PATH="$suite_path"
source scripts/reporting-metadata.sh
reporting_begin 5 suite
# Create an explicit manifest even if startup fails before the first child.
printf '' > "$suite_path/suite-members.jsonl" || printf 'Warning: unable to initialize reporting membership\n' >&2
export REPORT_SUITE_ID="${suite_path##*/}"
completed=0
cleanup() {
  result=$?
  printf '{"phase":5,"exitCode":%s,"completedGates":%s,"requiredGates":6}\n' "$result" "$completed" > "$suite_path/suite-result.json"
  reporting_finish
  printf 'Phase 5 suite exit=%s; evidence: %s\n' "$result" "$suite_path"
}
trap cleanup EXIT
run_gate() {
  name="$1"; shift
  export REPORT_GATE_ID="$name"
  "$@" 2>&1 | tee "$suite_path/$name.log"
  completed=$((completed + 1))
}
# Every gate is mandatory. Each owns a separate clean stack and evidence path.
run_gate scenario-assertions bash scripts/e2e-checks.sh
run_gate types-keys-ddl bash scripts/phase2.sh
run_gate recovery bash scripts/phase4.sh
run_gate malformed bash scripts/phase5.sh malformed
run_gate unsupported bash scripts/phase5.sh unsupported
# Fresh-stack reseed after destructive emulator-loss/poison probes above.
run_gate transactions-load bash scripts/phase5.sh workload
