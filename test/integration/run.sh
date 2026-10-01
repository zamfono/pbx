#!/usr/bin/env bash
# §8 "Integration": brings the stack up on whichever runtime `$COMPOSE` names, drives the REST
# surface to configure a tenant, and runs the sipp scenarios against it.
#
# The four features §6.3 "Runtimes" says differ between Docker and Podman are what this guards, so
# it asserts each of them explicitly rather than inferring them from a call that happened to work.
# Local run: build `DEVICES_IMAGE` first (see compose.test.yaml's `devices` service for how).
#
# Usage:
#   bash test/integration/run.sh
#     A full run: every prerequisite (bring-up, tenant configuration, device registration), every
#     named step (steps.sh, trunk-status.sh, cert-sync.sh) and every scenario under scenarios/, in
#     the same order this file always ran them in. cert-sync always runs last.
#
#   ONLY=<glob>[,<glob>...] bash test/integration/run.sh
#     Only the scenarios and named steps whose name matches one of the (comma-separated) globs —
#     see only.sh. The stack's own prerequisites still run first (REUSE aside): a scenario needs
#     a configured tenant to run against regardless of which one was asked for.
#
#   KEEP=1 bash test/integration/run.sh
#     Leaves the stack and its directory up after the run (full or ONLY), so a failure can be
#     reproduced by hand, or a later REUSE=<dir> run can reuse it; the run prints the directory.
#
#   REUSE=<dir> bash test/integration/run.sh
#     Skips bring-up, tenant configuration and device registration against the stack a previous
#     KEEP=1 run left up in <dir>, recovering the tenant state that run's configure.sh produced
#     (reuse.sh), then runs straight into the selected steps and scenarios. Falls back to a fresh
#     bring-up, with a message, when no such stack is up.
#     API_PORT and the other env vars compose.test.yaml reads must be the same as the run that
#     left the stack up, since REUSE never re-runs `compose up`. A run that actually reused a
#     stack leaves it up on exit too (as if KEEP=1), so further REUSE runs can chase it; tear it
#     down by hand (the message on exit gives the exact command) once done.
#
#   SHARD=<k>/<n> bash test/integration/run.sh
#     Plays every n-th scenario, from the k-th on, on a stack of its own; the named steps after the
#     scenarios run on the last shard only (only.sh). CI plays the scenarios as two shards.
#
#   UPGRADE_FROM=latest|<X.Y.Z> bash test/integration/run.sh
#     Starts the stack as that release, from its published bundle and images, and upgrades it to
#     the build under test the way deploy/README.md step 8 does before anything else runs; what
#     that release seeded must survive (upgrade.sh).
#
# Examples:
#   ONLY=inbound-hold bash test/integration/run.sh
#   KEEP=1 bash test/integration/run.sh
#   REUSE=/tmp/zamfono-it.Ab12Cd ONLY=inbound-hold bash test/integration/run.sh
#   REUSE=/tmp/zamfono-it.Ab12Cd ONLY='inbound-ring-group-voicemail,outbound-fallthrough' \
#     bash test/integration/run.sh
set -euo pipefail

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH= cd -- "$here/../.." && pwd)
COMPOSE=${COMPOSE:-docker compose}
FQDN=pbx.ci.test
API_PORT=${API_PORT:-8130}
SCENARIOS_DIR="$here/scenarios"
# The pin compose.test.yaml's `proxy` service requires (`${PROXY_IMAGE:?…}`): built the same way
# as the other four (docker-bake.hcl), so it defaults the same way ASTERISK_IMAGE etc. do below.
PROXY_IMAGE=${PROXY_IMAGE:-zamfono/proxy:ci}
# cert-sync.sh's own Caddyfile (§6.4): an absolute path, for the same reason SCENARIOS_DIR is one.
CERT_SYNC_CADDYFILE="$here/Caddyfile.local-ca"
export API_PORT SCENARIOS_DIR PROXY_IMAGE CERT_SYNC_CADDYFILE FQDN
api_base=http://127.0.0.1:$API_PORT
MAIN_DID=+15551000
# shellcheck source=../api.sh
. "$here/../api.sh"
# shellcheck source=../stack.sh
. "$here/../stack.sh"

# The stack runs from directory `$1` (test/stack.sh), as the Compose project of its name. The
# run's state lives there too: REUSE's (reuse.sh's `save_state`) and the scenarios' (`STATE_DIR`,
# scenarios/_lib.sh's `state_file`).
use_run_dir() {
  run_dir=$1
  compose_args=(-p "$(stack_project "$run_dir")" -f "$run_dir/compose.yaml"
    -f "$run_dir/compose.ports.yaml" -f "$here/compose.test.yaml")
  compose_cmd="$COMPOSE ${compose_args[*]}"
  STATE_FILE=$run_dir/integration-state
  STATE_DIR=$run_dir/state
  export STATE_DIR
}

# shellcheck source=diagnostics.sh
. "$here/diagnostics.sh"
fail() {
  echo "FAIL: $*" >&2
  dump_diagnostics
  exit 1
}

# `KEEP=1` leaves the stack and its directory in place, so a CI failure can be reproduced by hand
# against the same containers that produced it, or a later `REUSE=<dir>` run can reuse it. A
# `REUSE` run that actually reused a stack (`$reused`, set below) leaves it up the same way,
# whether or not `KEEP=1` was also given: it is reusing a stack some other run owns tearing down,
# same as the run that left it up in the first place did under `KEEP=1`. Otherwise the run removes
# what it made: its project's containers and volumes, and its directory.
cleanup() {
  [ -n "${run_dir:-}" ] || return 0
  if [ "${KEEP:-0}" = "1" ] || [ "${reused:-false}" = true ]; then
    echo "leaving the stack up: REUSE=$run_dir; when done," \
      "\`$COMPOSE -p $(stack_project "$run_dir") down -v && rm -rf $run_dir\`" >&2
    return
  fi
  $COMPOSE "${compose_args[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$run_dir"
}
trap cleanup EXIT

# It runs on the runtime `$COMPOSE` names, whose store holds the image: a Podman host need not
# have Docker at all, and Docker's client from v29 refuses the Docker-compatible API that Podman
# before 6 serves.
RUNTIME=${COMPOSE%% *}
OWNER_PASSWORD='integration-secret'
OWNER_EMAIL='owner@ci.test'

# shellcheck source=only.sh
. "$here/only.sh"
# shellcheck source=reuse.sh
. "$here/reuse.sh"
# shellcheck source=runtime-asserts.sh
. "$here/runtime-asserts.sh"
# shellcheck source=steps.sh
. "$here/steps.sh"
# shellcheck source=trunk-status.sh
. "$here/trunk-status.sh"
# shellcheck source=cert-sync.sh
. "$here/cert-sync.sh"
# shellcheck source=upgrade.sh
. "$here/upgrade.sh"

reused=false
if [ -n "${REUSE:-}" ]; then
  use_run_dir "$REUSE"
  if stack_is_up; then
    echo "== REUSE: reusing the stack a previous KEEP=1 run left up in $run_dir =="
    reused=true
  else
    echo "REUSE: no stack is fully up in $REUSE; falling back to a fresh bring-up" >&2
  fi
fi
if [ "$reused" = false ]; then
  use_run_dir "$(mktemp -d "${TMPDIR:-/tmp}/zamfono-it.XXXXXX")"
  stack_dir_files "$run_dir"
fi
# Relative paths name the stack directory's own files, as they do for an operator.
cd "$run_dir"

[ "$reused" = true ] || bring_up_stack

name_selected runtime-asserts && step_runtime_asserts
name_selected prompts && step_prompts

echo '== obtaining a bootstrap token =='
token=$(bash "$here/bootstrap-token.sh" "$api_base" "$OWNER_EMAIL" "$OWNER_PASSWORD" "https://$FQDN") \
  || fail "could not obtain an access token through the authorization-code flow"
[ -n "$token" ] || fail "the token endpoint returned nothing"

if [ -n "${UPGRADE_FROM:-}" ] && [ "$reused" = false ]; then
  upgrade_after=$run_dir/upgrade-after.tsv
  upgrade_snapshot "$upgrade_after"
  upgrade_verify "$UPGRADE_BEFORE" "$upgrade_after"
fi

if [ "$reused" = true ]; then
  load_state
else
  configure_tenant
  register_device
  save_state
fi

# shellcheck source=run-scenarios.sh
. "$here/run-scenarios.sh"

name_selected backups && step_backups
name_selected updater && step_updater

if shard_owns_steps && name_selected trunk-status; then
  run_trunk_status_step
fi

# Last (see cert-sync.sh's own comment for why): every sipp scenario, including device-tls-srtp,
# has already run its teardown, and nothing after this reads through Asterisk's TLS transport or
# depends on api staying up.
if shard_owns_steps && name_selected cert-sync; then
  [ "$reused" = true ] \
    && echo 'REUSE: cert-sync restarts api again; safe, but repeats the brief TLS-registration outage §6.4 describes' >&2
  run_cert_sync_step
fi

echo PASS
