#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export COMPOSE_PROJECT_NAME="maxwell-mysql57-checks-$(date +%s)-$$"
export TARGET_PORT=0
evidence="$PWD/artifacts/$COMPOSE_PROJECT_NAME"
mkdir -p "$evidence"
iteration=0
cleanup() {
  result=$?
  trap - EXIT
  docker compose logs --no-color mysql57 > "$evidence/final.log" 2>&1 || true
  container_id="$(docker compose ps -a -q mysql57)" || container_id=''
  if [ -n "$container_id" ]; then
    docker inspect "$container_id" > "$evidence/final-container.json" 2>&1 || true
    docker top "$container_id" -eo pid,ppid,user,stat,wchan:32,args > "$evidence/final-processes.txt" 2>&1 || true
  fi
  if [ "$result" -ne 0 ] && [ "${KEEP_ON_FAILURE:-0}" = 1 ]; then
    printf 'Kept project %s (including volumes)\n' "$COMPOSE_PROJECT_NAME"
  else
    docker compose down --volumes --remove-orphans || result=1
  fi
  printf '{"exitCode":%s,"iteration":%s,"project":"%s"}\n' "$result" "$iteration" "$COMPOSE_PROJECT_NAME" > "$evidence/result.json"
  printf 'MySQL 5.7 startup checks exit=%s; evidence: %s\n' "$result" "$evidence"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mysql_cdc() {
  docker compose exec -T mysql57 env MYSQL_PWD=cdc-local-only mysql -h127.0.0.1 -ucdc -N -B "$@"
}
check_process() {
  docker compose exec -T mysql57 bash -ec '
    test "$(awk "/^Uid:/{print \$2}" /proc/1/status)" = "$(id -u mysql)"
    tr "\0" " " < /proc/1/cmdline | grep -q mysqld
  '
}
docker compose build mysql57 2>&1 | tee "$evidence/build.log"
for iteration in 1 2 3; do
  if [ "$iteration" -gt 1 ]; then
    # Only this uniquely named test project; each iteration gets a new volume.
    docker compose down --volumes --remove-orphans
  fi
  docker compose up --no-build -d --wait --wait-timeout 240 mysql57 2>&1 | tee "$evidence/$iteration-cold-start.log"
  check_process
  test "$(mysql_cdc -e 'SELECT VERSION()')" = '5.7.42'
  # This user/grant comes from init.sql. Creating a marker also proves a fresh DB.
  mysql_cdc -e "CREATE DATABASE poc; CREATE TABLE poc.startup_marker (id INT PRIMARY KEY); INSERT INTO poc.startup_marker VALUES ($iteration)"
  docker compose restart mysql57
  docker compose up --no-build --no-recreate -d --wait --wait-timeout 240 mysql57 2>&1 | tee "$evidence/$iteration-warm-start.log"
  check_process
  test "$(mysql_cdc -e 'SELECT id FROM poc.startup_marker')" = "$iteration"
  docker compose logs --no-color mysql57 > "$evidence/$iteration-mysql57.log"
  docker inspect "$(docker compose ps -q mysql57)" > "$evidence/$iteration-container.json"
  printf 'PASS MySQL 5.7 cold start %s, unprivileged server, init SQL and warm restart\n' "$iteration" | tee "$evidence/$iteration-result.txt"
done
