#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/stack-lifecycle.sh
stack_validate_options
# A fresh project never modifies the Phase 1 stack or its volumes. Ephemeral host
# ports allow repeated runs without port collisions with that stack.
export COMPOSE_PROJECT_NAME="maxwell-phase2-$(date +%s)-$$"
export SOURCE_ID="$COMPOSE_PROJECT_NAME"
export CONSUMER_MODE=apply
export SOURCE_PORT=0 TARGET_PORT=0 PUBSUB_PORT=0
export ARTIFACT_PATH="$PWD/artifacts/$COMPOSE_PROJECT_NAME"
mkdir -p "$ARTIFACT_PATH"
source scripts/reporting-metadata.sh
reporting_begin 2
cleanup() {
  result=$?
  trap - EXIT
  docker compose logs --no-color > "$ARTIFACT_PATH/compose.log" 2>&1 || true
  docker compose images --format json > "$ARTIFACT_PATH/images.json" 2>&1 || true
  if stack_should_keep "$result"; then
    stack_retained_notice 2
  else
    docker compose down --volumes --remove-orphans || result=1
  fi
  printf '{"phase":2,"exitCode":%s,"project":"%s"}\n' "$result" "$COMPOSE_PROJECT_NAME" > "$ARTIFACT_PATH/result.json"
  reporting_finish
  printf 'Phase 2 exit=%s. Evidence: %s\n' "$result" "$ARTIFACT_PATH"
  exit "$result"
}
trap cleanup EXIT
docker compose up --build -d --wait --wait-timeout 240
docker compose run --rm --no-deps e2e phase2 2>&1 | tee "$ARTIFACT_PATH/probe.log"
# Recovery seams operate directly on the same target, after stopping the writer.
# They use isolated table names and synthetic source identities, not broker ACKs.
docker compose stop consumer
docker compose run --rm --no-deps e2e recovery-tests 2>&1 | tee "$ARTIFACT_PATH/recovery.log"
