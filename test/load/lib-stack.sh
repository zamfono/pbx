#!/usr/bin/env bash
# test/load: the stack bring-up shared by the load drivers (session.sh, stress/session.sh).
# Sourced, not run. Mirrors test/integration/run.sh's own bring-up: a generated deploy/.env, one
# `compose up`, the migrate exit code, the api and core healthchecks, a bootstrap owner token.
#
# The caller sets, before sourcing: repo, OUT_DIR, COMPOSE, compose_files (array, relative to
# deploy/), API, FQDN, MAIN_DID, API_IMAGE; optionally METRICS_TOKEN (default empty = /metrics
# off). It provides: dc, log, fail, api, stack_write_env, stack_up, stack_token, and sets
# STACK_UP=true once `compose up` ran (the caller's teardown trap keys `down -v` off it).
# RUNTIME (default: the first word of $COMPOSE, i.e. docker or podman) is the CLI used for the
# plain container/volume commands, so they hit the same image and volume store as the stack
# (test/integration/run.sh does the same).
# shellcheck shell=bash

RUNTIME=${RUNTIME:-${COMPOSE%% *}}
export RUNTIME

FWD=(-H 'X-Forwarded-For: 127.0.0.1')
STACK_UP=false
OWNER_PASSWORD='load-secret'
OWNER_EMAIL='owner@load.test'

dc() {
  # shellcheck disable=SC2086 # $COMPOSE carries the runtime's own multi-word command
  (cd "$repo/deploy" && $COMPOSE "${compose_files[@]}" "$@")
}

log() { echo "== $* ==" | tee -a "$OUT_DIR/session.log" >&2; }

fail() {
  echo "FAIL: $1" | tee -a "$OUT_DIR/session.log" >&2
  dc ps >&2 || true
  dc logs --tail 80 >&2 || true
  exit 1
}

api() {
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -fsS -X "$method" "$API/api/v1$path" "${FWD[@]}" \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body"
  else
    curl -fsS -X "$method" "$API/api/v1$path" "${FWD[@]}" -H "Authorization: Bearer $TOKEN"
  fi
}

stack_write_env() {
  local owner_hash
  owner_hash=$(printf '%s' "$OWNER_PASSWORD" \
    | "$RUNTIME" run --rm -i --entrypoint node "$API_IMAGE" hash-password.mjs) \
    || fail "could not hash the bootstrap owner password against $API_IMAGE"
  cat > "$repo/deploy/.env" <<ENV
FQDN=$FQDN
EXTERNAL_IPV4=172.28.0.10
RTP_PORT_START=10000
RTP_PORT_END=10200
ARI_PASSWORD=load-ari
AMI_PASSWORD=load-ami
JWT_SECRET=$(openssl rand -base64 32)
SECRETBOX_KEY=1:$(openssl rand -base64 32)
SECRETBOX_KEY_PREVIOUS=
SMTP_HOST=
SMTP_PORT=
SMTP_SECURITY=
SMTP_USER=
SMTP_PASSWORD=
MAIL_FROM=
BOOTSTRAP_OWNER_EMAIL=$OWNER_EMAIL
BOOTSTRAP_OWNER_NAME=Load Owner
BOOTSTRAP_OWNER_PASSWORD_HASH='$owner_hash'
COMPANY_NAME=Load
MAIN_DID=$MAIN_DID
COUNTRY=DE
EXT_LENGTH=3
TZ=UTC
TLS_RELOAD_HOUR=3
CALL_LOG_MAX_BYTES=1048576
HEP_ENABLED=false
SIP_UDP_ENABLED=true
SIP_TCP_ENABLED=true
METRICS_TOKEN=${METRICS_TOKEN:-}
ENV
}

stack_up() {
  local api_port=${API#*127.0.0.1:}
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
    curl -fsS "${FWD[@]}" "$API/healthz" >/dev/null 2>&1 && { ready=true; break; }
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
  TOKEN=$(bash "$repo/test/integration/bootstrap-token.sh" "$API" "$OWNER_EMAIL" \
    "$OWNER_PASSWORD" "https://$FQDN") || fail "could not obtain an access token"
  [ -n "$TOKEN" ] || fail "the token endpoint returned nothing"
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

# One line per named volume of compose project "deploy": name, mountpoint, du -sh.
stack_volume_sizes() {
  local vol mp
  for vol in deploy_db deploy_media deploy_caddy-data deploy_asterisk-config; do
    mp=$("$RUNTIME" volume inspect "$vol" --format '{{.Mountpoint}}' 2>/dev/null) || continue
    printf '%s\t%s\t%s\n' "$vol" "$mp" "$(du -sh "$mp" 2>/dev/null | cut -f1)"
  done
}
