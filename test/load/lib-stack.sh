#!/usr/bin/env bash
# test/load: the stack bring-up shared by the load drivers (session.sh, stress/session.sh).
# Sourced, not run. Mirrors test/integration/run.sh's own bring-up: a stack directory of the
# session's own with the .env setup.sh writes (test/stack.sh), one `compose up`, the migrate exit
# code, the api and core healthchecks, a bootstrap owner token.
#
# The caller sets, before sourcing: repo, OUT_DIR, COMPOSE, compose_args (array, relative to the
# stack directory), api_base, FQDN, MAIN_DID, API_IMAGE; optionally METRICS_TOKEN (default empty =
# /metrics off). Sourcing makes the stack directory, STACK_DIR, and changes into it, and sets
# compose_cmd; it provides: dc, log, fail, test/api.sh's helpers, stack_write_env, stack_up,
# stack_token, and sets STACK_UP=true once `compose up` ran (the caller's teardown trap keys
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
OWNER_PASSWORD='load-secret'
OWNER_EMAIL='owner@load.test'
# What the load stack runs differently from compose.yaml's defaults, handed to Compose through
# the environment, which it reads before .env: no HEP mirroring, and /metrics behind the token.
HEP_ENABLED=false
METRICS_TOKEN=${METRICS_TOKEN:-}
export HEP_ENABLED METRICS_TOKEN

STACK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/zamfono-load.XXXXXX")
stack_dir_files "$STACK_DIR"
compose_args=(-p "$(stack_project "$STACK_DIR")" "${compose_args[@]}")
# shellcheck disable=SC2034 # the callers' compose command for the scripts they run
compose_cmd="$COMPOSE ${compose_args[*]}"
cd "$STACK_DIR" || exit 1

dc() {
  # shellcheck disable=SC2086 # $COMPOSE carries the runtime's own multi-word command
  $COMPOSE "${compose_args[@]}" "$@"
}

log() { echo "== $* ==" | tee -a "$OUT_DIR/session.log" >&2; }

fail() {
  echo "FAIL: $1" | tee -a "$OUT_DIR/session.log" >&2
  dc ps >&2 || true
  dc logs --tail 80 >&2 || true
  exit 1
}

stack_write_env() {
  ZAMFONO_MODE=ports ZAMFONO_RUNTIME=$RUNTIME ZAMFONO_API_IMAGE=$API_IMAGE \
    EXTERNAL_IPV4=172.28.0.10 FQDN=$FQDN COMPANY_NAME=Load MAIN_DID=$MAIN_DID COUNTRY=DE \
    EXT_LENGTH=3 TZ=UTC BOOTSTRAP_OWNER_NAME='Load Owner' BOOTSTRAP_OWNER_EMAIL=$OWNER_EMAIL \
    OWNER_PASSWORD=$OWNER_PASSWORD stack_dir_env "$STACK_DIR" \
    || fail "setup.sh could not write the stack's .env: $(cat "$STACK_DIR/setup.log")"
}

stack_up() {
  local api_port=${api_base#*127.0.0.1:}
  if lsof -nP -iTCP:"$api_port" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "something already listens on 127.0.0.1:$api_port; set API_PORT to a free port"
  fi
  log "bringing the stack up"
  STACK_UP=true
  dc up -d || fail "compose up failed"

  local migrate_exit
  migrate_exit=$(dc ps -a --format '{{.Service}} {{.ExitCode}}' | awk '$1 == "migrate" { print $2 }')
  [ "$migrate_exit" = "0" ] || fail "migrate exited $migrate_exit"

  log "waiting for api healthcheck"
  local ready=false
  for _ in $(seq 1 60); do
    curl -fsS "${FWD[@]}" "$api_base/healthz" >/dev/null 2>&1 && { ready=true; break; }
    sleep 2
  done
  [ "$ready" = true ] || fail "api never became healthy"

  log "waiting for core healthcheck"
  ready=false
  for _ in $(seq 1 60); do
    [ "$(dc ps --format '{{.Service}} {{.Health}}' | awk '$1 == "core" { print $2 }')" = healthy ] \
      && { ready=true; break; }
    sleep 2
  done
  [ "$ready" = true ] || fail "core never became healthy"
}

stack_token() {
  log "obtaining a bootstrap token"
  token=$(bash "$repo/test/integration/bootstrap-token.sh" "$api_base" "$OWNER_EMAIL" \
    "$OWNER_PASSWORD" "https://$FQDN") || fail "could not obtain an access token"
  [ -n "$token" ] || fail "the token endpoint returned nothing"
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
