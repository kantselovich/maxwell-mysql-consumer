#!/usr/bin/env bash
# Shared end-of-run retention policy. Fault injection and watchdogs stay in the runners.
stack_validate_options() {
  case "${KEEP_STACK:-0}" in
    0|1) export KEEP_STACK="${KEEP_STACK:-0}" ;;
    *) printf 'KEEP_STACK must be 0 or 1\n' >&2; return 2 ;;
  esac
}

stack_should_keep() {
  [ "${KEEP_STACK:-0}" = 1 ] || { [ "$1" -ne 0 ] && [ "${KEEP_ON_FAILURE:-0}" = 1 ]; }
}

stack_retained_details() {
  local phase="$1" page="" file
  local -a files command
  case "$phase" in 3) page=basics ;; 4) page=recovery ;; 5) page=failures ;; esac
  # Capture the project and Compose interpolation context explicitly. Commands
  # remain scoped to this run even from another directory or shell environment.
  command=(env "ARTIFACT_PATH=$ARTIFACT_PATH" "SOURCE_ID=$SOURCE_ID"
    "CONSUMER_MODE=${CONSUMER_MODE:-apply}" SOURCE_PORT=0 TARGET_PORT=0 PUBSUB_PORT=0
    docker compose --project-directory "$PWD" -p "$COMPOSE_PROJECT_NAME")
  IFS=: read -r -a files <<< "${COMPOSE_FILE:-compose.yaml}"
  for file in "${files[@]}"; do
    if [[ "$file" != /* ]]; then file="$PWD/$file"; fi
    command+=(-f "$file")
  done
  printf 'End-of-run cleanup skipped; project resources are kept in their final test state.\nRun: %s\nCompose project: %s\nEvidence: %s\n' \
    "${ARTIFACT_PATH##*/}" "$COMPOSE_PROJECT_NAME" "$ARTIFACT_PATH"
  printf 'Inspect: '; printf '%q ' "${command[@]}" ps -a; printf '\n'
  printf 'Logs: '; printf '%q ' "${command[@]}" logs; printf '\n'
  printf 'Source port: '; printf '%q ' "${command[@]}" port mysql84 3306; printf '\n'
  printf 'Target port: '; printf '%q ' "${command[@]}" port mysql57 3306; printf '\n'
  printf 'Refresh/start dashboard: '; printf '%q ' make -C "$PWD" dashboard-view; printf '\n'
  if [ -n "$page" ]; then
    printf 'Dashboard: http://localhost:4173/%s?run=%s\n' "$page" "${ARTIFACT_PATH##*/}"
  else
    printf 'Dashboard: http://localhost:4173/\n'
  fi
  printf 'Cleanup (removes this project and its database volumes): '
  printf '%q ' "${command[@]}" down --volumes --remove-orphans; printf '\n'
}

stack_retained_notice() {
  stack_retained_details "$1" | tee "$ARTIFACT_PATH/retained-stack.txt" ||
    printf 'Warning: unable to save retained-stack instructions\n' >&2
  return 0
}
