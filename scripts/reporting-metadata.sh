#!/usr/bin/env bash
# Sourced by host runners. Best-effort reporting must never alter their verdict.
# Only constrained identifiers, UTC timestamps, commit hashes and booleans enter
# JSON: no environment dump, credentials, machine-specific paths or log parsing.
reporting_write() {
  local finished=null state=started
  if [ "$1" = finished ]; then
    finished="\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\""; state=finished
  fi
  printf '{"schemaVersion":1,"runId":"%s","phase":%s,"kind":"%s","state":"%s","startedAt":"%s","finishedAt":%s,"parentSuiteId":%s,"gateId":%s,"code":{"commit":%s,"dirty":%s}}\n' \
    "$report_run_id" "$report_phase" "$report_kind" "$state" "$report_started" "$finished" "$report_parent" "$report_gate" "$report_commit" "$report_dirty" \
    > "$ARTIFACT_PATH/run-metadata.json.tmp" &&
    mv "$ARTIFACT_PATH/run-metadata.json.tmp" "$ARTIFACT_PATH/run-metadata.json"
}
reporting_begin() {
  report_enabled=false
  report_phase="$1"; report_kind="${2:-run}"
  report_run_id="${ARTIFACT_PATH##*/}"
  if [[ ! "$report_phase" =~ ^[1-5]$ || ! "$report_kind" =~ ^(run|suite)$ || ! "$report_run_id" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$ ]]; then
    printf 'Warning: reporting metadata disabled: invalid run identity\n' >&2; return 0
  fi
  report_started="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  report_commit="$(git rev-parse HEAD 2>/dev/null)" || report_commit=""
  if [[ "$report_commit" =~ ^[a-f0-9]{40,64}$ ]]; then report_commit="\"$report_commit\""; else report_commit=null; fi
  report_dirty=null
  if report_status="$(git status --porcelain 2>/dev/null)"; then
    if [ -n "$report_status" ]; then report_dirty=true; else report_dirty=false; fi
  fi
  report_parent=null; report_gate=null
  if [ -n "${REPORT_SUITE_ID:-}" ] || [ -n "${REPORT_GATE_ID:-}" ]; then
    if [[ ! "${REPORT_SUITE_ID:-}" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$ || ! "${REPORT_GATE_ID:-}" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$ ]]; then
      printf 'Warning: reporting metadata disabled: invalid suite identity\n' >&2; return 0
    fi
    report_parent="\"$REPORT_SUITE_ID\""; report_gate="\"$REPORT_GATE_ID\""
  fi
  if reporting_write started; then
    report_enabled=true
    if [ "$report_parent" != null ]; then
      # Suite and child must be siblings under the runner's artifact root.
      report_suite_path="${ARTIFACT_PATH%/*}/$REPORT_SUITE_ID"
      if [ -d "$report_suite_path" ]; then
        printf '{"runId":"%s","gateId":"%s"}\n' "$report_run_id" "$REPORT_GATE_ID" >> "$report_suite_path/suite-members.jsonl" ||
          printf 'Warning: unable to record suite membership\n' >&2
      else printf 'Warning: suite artifact directory missing\n' >&2; fi
    fi
  else printf 'Warning: unable to write run metadata\n' >&2; fi
  return 0
}
reporting_finish() {
  if [ "${report_enabled:-false}" = true ]; then
    reporting_write finished || printf 'Warning: unable to finish run metadata\n' >&2
  fi
  return 0
}
