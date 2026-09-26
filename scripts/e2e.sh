#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export COMPOSE_PROJECT_NAME="maxwell-e2e-$(date +%s)-$$"
export SOURCE_ID="$COMPOSE_PROJECT_NAME"
export CONSUMER_MODE=apply SOURCE_PORT=0 TARGET_PORT=0 PUBSUB_PORT=0
export ARTIFACT_PATH="$PWD/artifacts/$COMPOSE_PROJECT_NAME"
harness_container="$COMPOSE_PROJECT_NAME-harness"
harness_started=false
harness_exit=-1
host_timeout="${E2E_MAX_SECONDS:-300}"
if [[ ! "$host_timeout" =~ ^[1-9][0-9]*$ ]] || [ "$host_timeout" -gt 7200 ]; then
  printf 'E2E_MAX_SECONDS must be 1–7200\n' >&2
  exit 2
fi
mkdir -p "$ARTIFACT_PATH"
cleanup() {
  result=$?
  trap - EXIT
  if "$harness_started"; then
    docker logs "$harness_container" > "$ARTIFACT_PATH/harness.log" 2>&1 || true
    docker inspect "$harness_container" > "$ARTIFACT_PATH/harness-container.json" 2>&1 || true
  fi
  docker compose logs --no-color > "$ARTIFACT_PATH/compose.log" 2>&1 || true
  docker compose ps -a --format json > "$ARTIFACT_PATH/services.json" 2>&1 || true
  docker compose images --format json > "$ARTIFACT_PATH/images.json" 2>&1 || true
  # Preserve health-check history and stuck PID 1 details before teardown.
  for service in mysql84 mysql57 pubsub pubsub-init maxwell consumer; do
    container_id="$(docker compose ps -a -q "$service" 2>/dev/null)" || continue
    [ -n "$container_id" ] || continue
    docker inspect "$container_id" > "$ARTIFACT_PATH/$service-container.json" 2>&1 || true
    docker top "$container_id" -eo pid,ppid,user,stat,wchan:32,args \
      > "$ARTIFACT_PATH/$service-processes.txt" 2>&1 || true
  done
  docker compose exec -T mysql84 env MYSQL_PWD=root-local-only mysql -uroot \
    -e 'SHOW BINARY LOG STATUS; SELECT * FROM maxwell.positions' > "$ARTIFACT_PATH/capture-checkpoint.tsv" 2>&1 || true
  docker compose exec -T mysql57 env MYSQL_PWD=root-local-only mysql -uroot \
    -e 'SELECT * FROM cdc_meta.checkpoints; SELECT event_id,completed FROM cdc_meta.ddl_journal; SELECT event_id FROM cdc_meta.applied_events' \
    > "$ARTIFACT_PATH/target-checkpoint.tsv" 2>&1 || true
  if [ "$result" -ne 0 ] && [ "${KEEP_ON_FAILURE:-0}" = 1 ]; then
    printf 'Kept project %s (including volumes); inspect with docker compose -p %s logs\n' "$COMPOSE_PROJECT_NAME" "$COMPOSE_PROJECT_NAME"
  else
    if "$harness_started"; then docker rm -f "$harness_container" >/dev/null || result=1; fi
    docker compose down --volumes --remove-orphans || result=1
  fi
  printf '{"phase":3,"exitCode":%s,"harnessExitCode":%s,"project":"%s"}\n' "$result" "$harness_exit" "$COMPOSE_PROJECT_NAME" > "$ARTIFACT_PATH/host-result.json"
  printf 'E2E exit=%s; evidence: %s\n' "$result" "$ARTIFACT_PATH"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker compose build 2>&1 | tee "$ARTIFACT_PATH/build.log"
docker compose up --no-build -d --wait --wait-timeout 240 2>&1 | tee "$ARTIFACT_PATH/startup.log"
# Host owns lifecycle/timeouts; the Swift container never gets a Docker socket.
docker compose run -d --no-deps --name "$harness_container" e2e e2e
harness_started=true
deadline=$((SECONDS + host_timeout))
while [ "$(docker inspect -f '{{.State.Running}}' "$harness_container")" = true ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    printf 'Host watchdog: harness exceeded %ss\n' "$host_timeout" >&2
    docker stop -t 5 "$harness_container" >/dev/null || true
    harness_exit=124
    exit 124
  fi
  sleep 1
done
harness_exit="$(docker inspect -f '{{.State.ExitCode}}' "$harness_container")"
docker logs "$harness_container" 2>&1 | tee "$ARTIFACT_PATH/harness.log"
for service in mysql84 mysql57 pubsub maxwell consumer; do
  container_id="$(docker compose ps -q "$service")"
  if [ -z "$container_id" ] || [ "$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id")" != 'running healthy' ]; then
    printf 'Required service is not healthy: %s\n' "$service" >&2
    exit 1
  fi
done
if [ "${VERIFY_NEGATIVE:-0}" = 1 ]; then
  if [ "$harness_exit" -ne 1 ]; then
    printf 'Expected assertion failure (exit 1), got %s\n' "$harness_exit" >&2
    exit 1
  fi
  docker compose run --rm --no-deps e2e harness-check-negative 2>&1 | tee "$ARTIFACT_PATH/negative-check.log"
else
  exit "$harness_exit"
fi
