#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
make dashboard
docker compose -f compose.dashboard.yaml build browser-tests
mkdir -p dashboard/live-results
live_artifacts="$(mktemp -d "$PWD/dashboard/live-results/live.XXXXXX")"
live_container="dashboard-live-$(date +%s)-$$"
cleanup() {
  result=$?
  trap - EXIT
  docker rm -f "$live_container" >/dev/null 2>&1 || true
  printf 'Live dashboard evidence: %s\n' "$live_artifacts"
  exit "$result"
}
trap cleanup EXIT
# Keep the browser open before starting the exact command shown on the page.
docker compose -f compose.dashboard.yaml run --rm --no-deps --name "$live_container" \
  -v "$live_artifacts:/live" live-browser > "$live_artifacts/browser.log" 2>&1 &
live_browser_pid=$!
ready_deadline=$((SECONDS + 90))
while [ ! -f "$live_artifacts/ready.json" ]; do
  if ! kill -0 "$live_browser_pid" 2>/dev/null || [ "$SECONDS" -ge "$ready_deadline" ]; then
    printf 'Live browser did not become ready; see %s/browser.log\n' "$live_artifacts" >&2
    exit 1
  fi
  sleep 1
done
set +e
make e2e-checks WRITE_INTERVAL_MS=250 2>&1 | tee "$live_artifacts/harness.log"
live_harness_exit=${PIPESTATUS[0]}
set -e
printf '{"exitCode":%s}\n' "$live_harness_exit" > "$live_artifacts/completed.json"
set +e
wait "$live_browser_pid"
live_browser_exit=${PIPESTATUS[0]}
set -e
cat "$live_artifacts/browser.log"
if [ "$live_harness_exit" -ne 0 ]; then exit "$live_harness_exit"; fi
exit "$live_browser_exit"
