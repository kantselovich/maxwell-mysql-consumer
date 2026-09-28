#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export CONSUMER_MODE=observe
export ARTIFACT_PATH="$PWD/artifacts/maxwell-phase1-$(date +%s)-$$"
mkdir -p "$ARTIFACT_PATH"
source scripts/reporting-metadata.sh
reporting_begin 1
replay_container="maxwell-poc-replay-$$"
replay_started=false
maxwell_stopped=false
cleanup() {
  result=$?
  trap - EXIT
  if "$replay_started"; then
    docker stop "$replay_container" >/dev/null || true
    docker logs "$replay_container" > "$ARTIFACT_PATH/replay.log" 2>&1 || true
    docker rm "$replay_container" >/dev/null || true
  fi
  if "$maxwell_stopped"; then
    docker compose up -d --no-build --no-recreate --no-deps --wait --wait-timeout 120 maxwell || result=1
  fi
  docker compose logs --no-color > "$ARTIFACT_PATH/compose.log" 2>&1 || true
  printf '{"phase":1,"exitCode":%s}\n' "$result" > "$ARTIFACT_PATH/result.json"
  reporting_finish
  if [ "$result" -eq 0 ]; then
    printf 'Phase 1 passed; normal capture restored. Evidence: %s\n' "$ARTIFACT_PATH"
  fi
  exit "$result"
}
trap cleanup EXIT
docker compose up --build -d --wait --wait-timeout 240
docker compose run --rm --no-deps e2e probe 2>&1 | tee "$ARTIFACT_PATH/probe.log"
replay_position="$(docker compose run --rm --no-deps e2e replay-position)"
if [[ ! "$replay_position" =~ ^[a-zA-Z0-9._-]+:[0-9]+$ ]]; then
  printf 'Invalid replay position: %s\n' "$replay_position" >&2
  exit 1
fi
docker compose stop maxwell
maxwell_stopped=true
# Maxwell's schema lookup uses both binlog position and a heartbeat upper bound.
# Omitting the heartbeat defaults it to zero and can select the initial schema.
replay_heartbeat="$(docker compose exec -T mysql84 env MYSQL_PWD=root-local-only mysql -uroot -N -e 'SELECT COALESCE(MAX(last_heartbeat_read),0) FROM maxwell.positions')"
if [[ ! "$replay_heartbeat" =~ ^[0-9]+$ ]]; then
  printf 'Invalid replay heartbeat: %s\n' "$replay_heartbeat" >&2
  exit 1
fi
printf '%s:%s\n' "$replay_position" "$replay_heartbeat" > "$ARTIFACT_PATH/replay-position.txt"
docker compose run -d --no-deps --name "$replay_container" maxwell \
  bin/maxwell --config=/etc/maxwell/config.properties --init_position="$replay_position:$replay_heartbeat" --replay
replay_started=true
docker compose run --rm --no-deps e2e verify-replay 2>&1 | tee "$ARTIFACT_PATH/verify-replay.log"
docker compose images --format json > "$ARTIFACT_PATH/images.json"
