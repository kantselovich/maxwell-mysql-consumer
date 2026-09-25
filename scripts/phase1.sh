#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p artifacts
replay_container="maxwell-poc-replay-$$"
replay_started=false
maxwell_stopped=false
cleanup() {
  result=$?
  trap - EXIT
  if "$replay_started"; then
    docker stop "$replay_container" >/dev/null || true
    docker logs "$replay_container" > artifacts/replay.log 2>&1 || true
    docker rm "$replay_container" >/dev/null || true
  fi
  if "$maxwell_stopped"; then
    docker compose up -d --no-build --no-recreate --no-deps --wait --wait-timeout 120 maxwell || result=1
  fi
  docker compose logs --no-color > artifacts/compose.log 2>&1 || true
  printf '{"phase":1,"exitCode":%s}\n' "$result" > artifacts/result.json
  if [ "$result" -eq 0 ]; then
    printf 'Phase 1 passed; normal capture restored. Evidence is in artifacts/.\n'
  fi
  exit "$result"
}
trap cleanup EXIT
docker compose up --build -d --wait --wait-timeout 240
docker compose run --rm --no-deps e2e probe 2>&1 | tee artifacts/probe.log
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
printf '%s:%s\n' "$replay_position" "$replay_heartbeat" > artifacts/replay-position.txt
docker compose run -d --no-deps --name "$replay_container" maxwell \
  bin/maxwell --config=/etc/maxwell/config.properties --init_position="$replay_position:$replay_heartbeat" --replay
replay_started=true
docker compose run --rm --no-deps e2e verify-replay 2>&1 | tee artifacts/verify-replay.log
docker compose images --format json > artifacts/images.json
