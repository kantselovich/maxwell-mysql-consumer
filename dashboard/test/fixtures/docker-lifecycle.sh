#!/usr/bin/env bash
# Lifecycle-only fake: exercises host control flow without Docker or databases.
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = compose ]; then
  shift
  while [[ "${1:-}" = -* ]]; do shift 2; done
  operation="$1"; shift
  case "$operation" in
    up) exit "${FAKE_STARTUP_EXIT:-0}" ;;
    ps)
      if [[ " $* " = *' -q '* ]]; then printf '%s-%s\n' "$COMPOSE_PROJECT_NAME" "${!#}"; else printf '[]\n'; fi ;;
    restart)
      if [ "$1" = pubsub ]; then touch "$ARTIFACT_PATH/fake-queue-lost"; fi ;;
    run)
      mkdir -p "$ARTIFACT_PATH/control"
      printf '{}\n' > "$ARTIFACT_PATH/control/reached.json"
      code="${FAKE_HARNESS_EXIT:-0}"
      if [ "$code" = 0 ]; then
        case " $* " in
          *' e2e e2e '*) if [ "${VERIFY_NEGATIVE:-0}" = 1 ]; then code=1; fi ;;
          *' e2e health '*) code=1 ;;
          *' e2e phase4 fix-target '*) touch "$ARTIFACT_PATH/fake-repaired" ;;
          *' e2e repair '*)
            if [ -f "$ARTIFACT_PATH/fake-repaired" ]; then rm "$ARTIFACT_PATH/fake-repaired"; else code=1; fi ;;
        esac
      fi
      printf '%s\n' "$code" > "$ARTIFACT_PATH/fake-exit"
      if [[ " $* " != *' -d '* ]]; then exit "$code"; fi ;;
    logs) printf 'LEASE_RENEWED\nLEASE_RENEWED\nLEASE_RENEWED\nRETRY\n' ;;
  esac
elif [ "$1" = inspect ]; then
  if [ "${2:-}" != -f ]; then printf '[]\n'; exit 0; fi
  case "$3" in
    '{{.State.Running}}')
      if [[ "${!#}" = *-consumer ]] && [ ! -f "$ARTIFACT_PATH/fake-queue-lost" ]; then printf 'true\n'; else printf 'false\n'; fi ;;
    '{{.State.ExitCode}}')
      if [[ "${!#}" = *-consumer ]]; then printf '1\n'; else cat "$ARTIFACT_PATH/fake-exit"; fi ;;
    *) printf 'running healthy\n' ;;
  esac
elif [ "$1" = logs ]; then
  printf 'DML old primary key does not identify exactly one target row\nStream blocked by durable quarantine\ndataCorrupted\nExpected DROP in supported DDL subset\nPub/Sub resource missing\n'
elif [ "$1" = stats ]; then
  printf '{"Name":"fake-consumer","MemUsage":"6MiB / 8GiB"}\n'
fi
