#!/usr/bin/env bash
# test/load: the stack bring-up shared by the load drivers (session.sh, stress/session.sh).
# Sourced, not run. test/stack.sh's bring-up, on a stack directory of the session's own.
#
# The caller sets, before sourcing: repo, OUT_DIR, COMPOSE, compose_args (array, relative to the
# stack directory), api_base, FQDN, MAIN_DID, API_IMAGE; optionally METRICS_TOKEN (default empty =
# /metrics off). Sourcing makes the stack directory, STACK_DIR, and changes into it, and sets
# compose; it provides: log, fail, test/api.sh's and test/stack.sh's helpers, and stack_up, which
# sets STACK_UP=true once `compose up` ran (the caller's teardown trap keys
# `down -v` off it, and removes STACK_DIR).
# RUNTIME (default: the first word of $COMPOSE, i.e. docker or podman) is the CLI used for the
# plain container/volume commands, so they hit the same image and volume store as the stack
# (test/integration/run.sh does the same).
# shellcheck shell=bash

RUNTIME=${RUNTIME:-${COMPOSE%% *}}
export RUNTIME

# shellcheck source=../api.sh
. "$repo/test/api.sh"
# shellcheck source=../stack.sh
. "$repo/test/stack.sh"
STACK_UP=false
# What the load stack runs differently from compose.yaml's defaults, handed to Compose through
# the environment, which it reads before .env: no HEP mirroring, and /metrics behind the token.
HEP_ENABLED=false
METRICS_TOKEN=${METRICS_TOKEN:-}
export HEP_ENABLED METRICS_TOKEN

STACK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/zamfono-load.XXXXXX")
stack_dir_files "$STACK_DIR"
compose_args=(-p "$(stack_project "$STACK_DIR")" "${compose_args[@]}")
compose="$COMPOSE ${compose_args[*]}"
cd "$STACK_DIR" || exit 1

log() { echo "== $* ==" | tee -a "$OUT_DIR/session.log" >&2; }

fail() {
  echo "FAIL: $*" | tee -a "$OUT_DIR/session.log" >&2
  dc ps >&2 || true
  dc logs --tail 80 >&2 || true
  exit 1
}

# The stack's .env, then the stack itself, up once healthy and migrated; EXTERNAL_IPV4 is
# `asterisk`'s fixed address in compose.load.yaml.
stack_up() {
  stack_port_free "$API_PORT"
  stack_write_env "$STACK_DIR" Load 172.28.0.10
  log "bringing the stack up"
  STACK_UP=true
  stack_recreate
  stack_assert_migrated
}

# Host facts for the sizing record (docs/spec.md §6.6): nproc, CPU model, free -m, runtimes.
stack_host_facts() {
  {
    echo "date: $(date -u +%FT%TZ)"
    echo "nproc: $(nproc)"
    echo "cpu_model: $(awk -F': ' '/model name/ {print $2; exit}' /proc/cpuinfo)"
    echo "free_m:"
    free -m
    echo "runtime: $("$RUNTIME" --version)"
    echo "compose: $($COMPOSE version 2>&1 | head -1)"
  } > "$OUT_DIR/host-facts.txt"
  log "host facts written to $OUT_DIR/host-facts.txt"
}

# One line per named volume of the stack's Compose project: name, mountpoint, du -sh.
stack_volume_sizes() {
  local vol mp project
  project=$(stack_project "$STACK_DIR")
  for vol in "${project}_db" "${project}_media" "${project}_caddy-data" \
    "${project}_asterisk-config"; do
    mp=$("$RUNTIME" volume inspect "$vol" --format '{{.Mountpoint}}' 2>/dev/null) || continue
    printf '%s\t%s\t%s\n' "$vol" "$mp" "$(du -sh "$mp" 2>/dev/null | cut -f1)"
  done
}
