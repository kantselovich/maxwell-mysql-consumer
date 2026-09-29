#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/stack-lifecycle.sh
stack_validate_options
mode="${1:-workload}"
case "$mode" in workload|malformed|unsupported) ;; *) printf 'Unknown Phase 5 mode\n' >&2; exit 2 ;; esac
host_timeout="${E2E_MAX_SECONDS:-300}"
if [[ ! "$host_timeout" =~ ^[1-9][0-9]*$ ]] || [ "$host_timeout" -gt 7200 ]; then
  printf 'E2E_MAX_SECONDS must be 1–7200\n' >&2; exit 2
fi
export COMPOSE_PROJECT_NAME="maxwell-phase5-$mode-$(date +%s)-$$"
export COMPOSE_FILE=compose.yaml
export SOURCE_ID="$COMPOSE_PROJECT_NAME" CONSUMER_MODE=apply
export SOURCE_PORT=0 TARGET_PORT=0 PUBSUB_PORT=0
export ARTIFACT_PATH="$PWD/artifacts/$COMPOSE_PROJECT_NAME"
export SCENARIO=smoke HARNESS_FAULT=none
mkdir -p "$ARTIFACT_PATH"
source scripts/reporting-metadata.sh
reporting_begin 5
probe_container="$COMPOSE_PROJECT_NAME-probe"
probe_number=0
stats_pid=""
cleanup() {
  result=$?
  trap - EXIT
  if [ -n "$stats_pid" ]; then kill "$stats_pid" 2>/dev/null || true; wait "$stats_pid" 2>/dev/null || true; fi
  docker logs "$probe_container" > "$ARTIFACT_PATH/last-probe.log" 2>&1 || true
  docker compose logs --no-color > "$ARTIFACT_PATH/compose.log" 2>&1 || true
  docker compose ps -a --format json > "$ARTIFACT_PATH/services.json" 2>&1 || true
  docker compose images --format json > "$ARTIFACT_PATH/images.json" 2>&1 || true
  for service in mysql84 mysql57 pubsub maxwell consumer; do
    id="$(docker compose ps -a -q "$service" 2>/dev/null)" || continue
    [ -n "$id" ] || continue
    docker inspect "$id" > "$ARTIFACT_PATH/$service-container.json" 2>&1 || true
  done
  docker compose exec -T mysql84 env MYSQL_PWD=root-local-only mysql -uroot \
    -e 'SHOW BINARY LOG STATUS; SELECT * FROM maxwell.positions' > "$ARTIFACT_PATH/capture-checkpoint.tsv" 2>&1 || true
  docker compose exec -T mysql57 env MYSQL_PWD=root-local-only mysql -uroot \
    -e 'SELECT * FROM cdc_meta.checkpoints; SELECT * FROM cdc_meta.consumer_head; SELECT * FROM cdc_meta.quarantine' > "$ARTIFACT_PATH/applied-checkpoint.tsv" 2>&1 || true
  if stack_should_keep "$result"; then
    stack_retained_notice 5
  else
    if docker inspect "$probe_container" >/dev/null 2>&1; then docker rm -f "$probe_container" >/dev/null || result=1; fi
    docker compose down --volumes --remove-orphans || result=1
  fi
  printf '{"phase":5,"mode":"%s","exitCode":%s,"project":"%s","completedProbes":%s}\n' "$mode" "$result" "$COMPOSE_PROJECT_NAME" "$probe_number" > "$ARTIFACT_PATH/host-result.json"
  reporting_finish
  printf 'Phase 5 exit=%s; evidence: %s\n' "$result" "$ARTIFACT_PATH"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
probe() {
  probe_number=$((probe_number + 1))
  docker compose run -d --no-deps --name "$probe_container" e2e "$@" >/dev/null || return 125
  deadline=$((SECONDS + host_timeout))
  while [ "$(docker inspect -f '{{.State.Running}}' "$probe_container")" = true ]; do
    if [ "$SECONDS" -ge "$deadline" ]; then docker stop -t 2 "$probe_container" >/dev/null || true; return 124; fi
    sleep 1
  done
  docker logs "$probe_container" 2>&1 | tee "$ARTIFACT_PATH/probe-$probe_number.log"
  code="$(docker inspect -f '{{.State.ExitCode}}' "$probe_container")"
  docker rm "$probe_container" >/dev/null
  return "$code"
}
docker compose build 2>&1 | tee "$ARTIFACT_PATH/build.log"
docker compose up --no-build -d --wait --wait-timeout 240 2>&1 | tee "$ARTIFACT_PATH/startup.log"
# Project-scoped raw memory/CPU samples (including paused/stopped periods).
consumer_id="$(docker compose ps -q consumer)"
maxwell_id="$(docker compose ps -q maxwell)"
(
  while true; do
    date -u '+%Y-%m-%dT%H:%M:%SZ'
    docker stats --no-stream --format '{{json .}}' "$consumer_id" "$maxwell_id"
    sleep 2
  done
) > "$ARTIFACT_PATH/memory-samples.log" 2>&1 &
stats_pid=$!
probe phase5 setup
if [ "$mode" = workload ]; then
  docker compose stop consumer
  probe phase5 backlog
  # Explicit rotation in addition to the source-restart probe in Phase 4.
  docker compose exec -T mysql84 env MYSQL_PWD=root-local-only mysql -uroot \
    -e 'SHOW BINARY LOG STATUS; FLUSH BINARY LOGS; SHOW BINARY LOG STATUS' > "$ARTIFACT_PATH/binlog-rotation.tsv"
  probe phase5 mark-recovery
  docker compose start consumer
  probe phase5 stream
  probe phase5 verify
  grep -q '"MemUsage"' "$ARTIFACT_PATH/memory-samples.log"
  for service in mysql84 mysql57 pubsub maxwell consumer; do
    id="$(docker compose ps -q "$service")"
    test "$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id")" = 'running healthy'
  done
else
  probe phase5 "poison-$mode"
  if probe health; then printf 'Blocked consumer unexpectedly reported healthy\n' >&2; exit 1; else
    health_exit=$?
    test "$health_exit" = 1
    grep -q 'Stream blocked by durable quarantine' "$ARTIFACT_PATH/probe-$probe_number.log"
  fi
  docker compose restart consumer
  probe phase5 assert-blocked
  docker compose stop consumer
  if probe repair; then printf 'Unsupported/unfixed poison unexpectedly repaired\n' >&2; exit 1; else
    repair_exit=$?
    test "$repair_exit" = 1
    if [ "$mode" = malformed ]; then reason=dataCorrupted; else reason='Expected DROP in supported DDL subset'; fi
    grep -q "$reason" "$ARTIFACT_PATH/probe-$probe_number.log"
  fi
  probe phase5 assert-blocked
  docker compose start consumer
  probe phase5 assert-blocked
fi
printf 'PASS Phase 5 %s\n' "$mode"
