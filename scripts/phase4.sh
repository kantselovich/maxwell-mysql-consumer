#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/stack-lifecycle.sh
stack_validate_options
export COMPOSE_PROJECT_NAME="maxwell-phase4-$(date +%s)-$$"
export COMPOSE_FILE=compose.yaml:compose.phase4.yaml
export SOURCE_ID="$COMPOSE_PROJECT_NAME" CONSUMER_MODE=apply
export SOURCE_PORT=0 TARGET_PORT=0 PUBSUB_PORT=0
export ARTIFACT_PATH="$PWD/artifacts/$COMPOSE_PROJECT_NAME"
mkdir -p "$ARTIFACT_PATH/control"
source scripts/reporting-metadata.sh
reporting_begin 4
probe_container="$COMPOSE_PROJECT_NAME-probe"
probe_number=0
cleanup() {
  result=$?
  trap - EXIT
  docker logs "$probe_container" > "$ARTIFACT_PATH/last-probe.log" 2>&1 || true
  docker compose logs --no-color > "$ARTIFACT_PATH/compose.log" 2>&1 || true
  docker compose ps -a --format json > "$ARTIFACT_PATH/services.json" 2>&1 || true
  for service in mysql84 mysql57 pubsub maxwell consumer; do
    id="$(docker compose ps -a -q "$service" 2>/dev/null)" || continue
    [ -n "$id" ] || continue
    docker inspect "$id" > "$ARTIFACT_PATH/$service-container.json" 2>&1 || true
    docker top "$id" -eo pid,ppid,user,stat,wchan:32,args > "$ARTIFACT_PATH/$service-processes.txt" 2>&1 || true
  done
  docker compose exec -T mysql84 env MYSQL_PWD=root-local-only mysql -uroot \
    -e 'SHOW BINARY LOG STATUS; SELECT * FROM maxwell.positions' > "$ARTIFACT_PATH/capture-checkpoint.tsv" 2>&1 || true
  docker compose exec -T mysql57 env MYSQL_PWD=root-local-only mysql -uroot \
    -e 'SELECT * FROM cdc_meta.checkpoints; SELECT * FROM cdc_meta.consumer_head; SELECT * FROM cdc_meta.quarantine' > "$ARTIFACT_PATH/applied-checkpoint.tsv" 2>&1 || true
  if stack_should_keep "$result"; then
    stack_retained_notice 4
  else
    docker compose down --volumes --remove-orphans || result=1
  fi
  printf '{"phase":4,"exitCode":%s,"project":"%s","completedProbes":%s}\n' "$result" "$COMPOSE_PROJECT_NAME" "$probe_number" > "$ARTIFACT_PATH/host-result.json"
  reporting_finish
  printf 'Phase 4 exit=%s; evidence: %s\n' "$result" "$ARTIFACT_PATH"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
probe() {
  probe_number=$((probe_number + 1))
  docker compose run -d --no-deps --name "$probe_container" e2e "$@" >/dev/null || return 125
  deadline=$((SECONDS + 120))
  while [ "$(docker inspect -f '{{.State.Running}}' "$probe_container")" = true ]; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      docker stop -t 2 "$probe_container" >/dev/null || true
      printf 'Phase 4 probe timed out: %s\n' "$*" >&2
      return 124
    fi
    sleep 1
  done
  docker logs "$probe_container" 2>&1 | tee "$ARTIFACT_PATH/probe-$probe_number.log"
  code="$(docker inspect -f '{{.State.ExitCode}}' "$probe_container")"
  docker rm "$probe_container" >/dev/null
  return "$code"
}
wait_gate() {
  deadline=$((SECONDS + 60))
  until [ -f "$ARTIFACT_PATH/control/reached.json" ]; do
    if [ "$SECONDS" -ge "$deadline" ]; then printf 'Fault gate was not reached\n' >&2; return 1; fi
    sleep 1
  done
}
start_consumer() { docker compose start consumer; }
docker compose build 2>&1 | tee "$ARTIFACT_PATH/build.log"
docker compose up --no-build -d --wait --wait-timeout 240 2>&1 | tee "$ARTIFACT_PATH/startup.log"
probe phase4 setup
probe phase4 verify

probe phase4 arm-before-commit
probe phase4 write-before-commit
wait_gate
# Hold longer than the 10s lease, proving renewals continue during SQL work.
sleep 12
docker compose logs --no-color consumer > "$ARTIFACT_PATH/lease-renewals.log"
test "$(grep -c 'LEASE_RENEWED' "$ARTIFACT_PATH/lease-renewals.log")" -ge 3
docker compose kill -s SIGKILL consumer
probe phase4 assert-before-commit
start_consumer
probe phase4 verify

probe phase4 arm-after-commit
probe phase4 write-after-commit
wait_gate
docker compose kill -s SIGKILL consumer
probe phase4 assert-after-commit
start_consumer
probe phase4 verify

probe phase4 arm-ddl
probe phase4 write-ddl
wait_gate
docker compose kill -s SIGKILL consumer
probe phase4 assert-ddl
start_consumer
probe phase4 verify

docker compose stop mysql57
probe phase4 write-outage
sleep 6
test "$(docker inspect -f '{{.State.Running}}' "$(docker compose ps -a -q consumer)")" = true
docker compose logs --no-color consumer > "$ARTIFACT_PATH/target-outage.log"
grep -q 'RETRY' "$ARTIFACT_PATH/target-outage.log"
docker compose up --no-build --no-recreate -d --wait --wait-timeout 240 mysql57
probe phase4 verify

docker compose stop maxwell
probe phase4 write-capture-restart
docker compose up --no-build --no-recreate -d --wait --wait-timeout 240 maxwell
probe phase4 verify
docker compose restart mysql84
docker compose up --no-build --no-recreate -d --wait --wait-timeout 240 mysql84
probe phase4 write-source-restart
probe phase4 verify
probe phase4 replay
probe phase4 verify

# Both poison events are real source updates whose target row was deliberately
# removed. A following update must remain unapplied until exact-byte repair.
for point in after-quarantine after-dlq-publish; do
  probe phase4 break-target
  probe phase4 "arm-$point"
  probe phase4 "write-poison-$point"
  wait_gate
  probe phase4 "write-behind-$point"
  if [ "$point" = after-quarantine ]; then probe phase4 assert-quarantine-durable; fi
  docker compose kill -s SIGKILL consumer
  start_consumer
  probe phase4 assert-blocked
  if [ "$point" = after-dlq-publish ]; then probe phase4 assert-duplicate-dlq; fi
  docker compose restart consumer
  probe phase4 assert-blocked
  docker compose stop consumer
  # A retry without fixing the cause must fail, leaving quarantine intact.
  if probe repair; then
    printf 'Unrepaired poison unexpectedly succeeded\n' >&2; exit 1
  else
    repair_exit=$?
    test "$repair_exit" = 1
    grep -q 'DML old primary key does not identify exactly one target row' "$ARTIFACT_PATH/probe-$probe_number.log"
  fi
  probe phase4 assert-blocked
  probe phase4 fix-target
  probe repair
  start_consumer
  probe phase4 verify
done

# Emulator resources/messages are session-local. Loss must be visible, with no
# automatic queue recreation that could make missing events look successful.
docker compose restart pubsub
docker compose up --no-build --no-recreate -d --wait --wait-timeout 240 pubsub
consumer_id="$(docker compose ps -a -q consumer)"
deadline=$((SECONDS + 45))
while [ "$(docker inspect -f '{{.State.Running}}' "$consumer_id")" = true ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then printf 'Consumer did not detect queue loss\n' >&2; exit 1; fi
  sleep 1
done
test "$(docker inspect -f '{{.State.ExitCode}}' "$consumer_id")" = 1
docker logs "$consumer_id" > "$ARTIFACT_PATH/queue-loss.log" 2>&1
grep -q 'Pub/Sub resource missing' "$ARTIFACT_PATH/queue-loss.log"
probe phase4 assert-resources-lost
printf 'PASS Phase 4 crash/restart/outage/replay/quarantine/repair/queue-loss checks\n'
