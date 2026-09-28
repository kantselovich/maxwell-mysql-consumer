#!/usr/bin/env bash
# A host-runner path/metadata fixture, not a replication or Docker test.
case "$*" in
  *replay-position*) printf 'binlog.000001:10\n' ;;
  *COALESCE*) printf '123\n' ;;
  *'images --format json'*) printf '[]\n' ;;
esac
