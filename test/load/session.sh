#!/usr/bin/env bash
# test/load: the top-level driver for one resource-sizing measurement session (docs/spec.md §6.6
# "Sizing envelope"). Brings up one stack the way test/integration/run.sh does (same compose
# files plus this directory's own compose.load.yaml, same REST-driven tenant bring-up), then runs
# the idle / 10 / 25 / 50 concurrent-call / transcoding load steps and the 200-endpoint reload
# probe, sampling `docker stats` and host veth byte counters throughout.
#
# Must be run under the shared harness lock, with this script's own teardown happening before the
# lock is released:
#   flock /root/pbx-harness.lock bash test/load/session.sh
#
# Everything here tears itself down on the way out (the `cleanup` trap below), whether it
# succeeded, failed partway, or a load step could not reach its target concurrency -- a step that
# falls short is reported as such (see each step's *-summary.txt "ramp_reached"), never silently
# skipped or faked.
set -uo pipefail

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH= cd -- "$here/../.." && pwd)
COMPOSE=${COMPOSE:-docker compose}
FQDN=pbx.load.test
API_PORT=${API_PORT:-8140}
export API_PORT  # compose.load.yaml interpolates ${API_PORT:-8140} from the environment, not
                  # from this script's own shell variable, so a caller-supplied override must be
                  # exported for the api service's published port to actually follow it.
api_base="http://127.0.0.1:$API_PORT"
MAIN_DID=+15551000
OUT_DIR=${OUT_DIR:-$here/results}
mkdir -p "$OUT_DIR"

LOAD_GEN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/zamfono-load-gen.XXXXXX")
export SCENARIOS_DIR="$repo/test/integration/scenarios"
export LOAD_SCENARIOS_DIR="$here/scenarios"
export LOAD_GEN_DIR

ASTERISK_IMAGE=${ASTERISK_IMAGE:-zamfono/asterisk:load}
MIGRATE_IMAGE=${MIGRATE_IMAGE:-zamfono/migrate:load}
CORE_IMAGE=${CORE_IMAGE:-zamfono/core:load}
API_IMAGE=${API_IMAGE:-zamfono/api:load}
PROXY_IMAGE=${PROXY_IMAGE:-zamfono/proxy:load}
export ASTERISK_IMAGE MIGRATE_IMAGE CORE_IMAGE API_IMAGE PROXY_IMAGE

# compose.override.yaml is the ports overlay setup.sh links; with a `-f` for the load overlay,
# Compose reads it only when named.
compose_args=(-f compose.yaml -f compose.override.yaml -f "$here/compose.load.yaml")
# shellcheck source=test/load/lib-stack.sh
. "$here/lib-stack.sh"

cleanup() {
  local status=$?
  log "tearing down (exit status so far: $status)"
  if [ "$STACK_UP" = true ]; then
    dc down -v --remove-orphans >>"$OUT_DIR/session.log" 2>&1 || true
  fi
  rm -rf "$STACK_DIR"
  rm -rf "$LOAD_GEN_DIR"
  for img in "$ASTERISK_IMAGE" "$MIGRATE_IMAGE" "$CORE_IMAGE" "$API_IMAGE"; do
    "$RUNTIME" rmi "$img" >>"$OUT_DIR/session.log" 2>&1 || true
  done
  log "teardown complete"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. Host facts, then the stack itself (lib-stack.sh, shared with stress/).
# ---------------------------------------------------------------------------
stack_host_facts
stack_up
stack_token

sipp_ip=$(container_ip sipp)
phone_ip=$(container_ip sipp-phone)
provider_ip=$(container_ip sipp-provider)
phone_cidr="${phone_ip%.*}.0/24"
log "sipp=$sipp_ip sipp-phone=$phone_ip sipp-provider=$provider_ip"

log "configuring the tenant"
read -r SIP_USERNAME SIP_PASSWORD < <(
  bash "$here/configure-load.sh" "$api_base" "$token" "$sipp_ip" "$provider_ip" "$phone_cidr"
) || fail "tenant configuration failed"
[ -n "${SIP_USERNAME:-}" ] || fail "no device credentials came back from configure-load.sh"

# The one answering device registered and served for the whole session, as the integration
# harness's phone is for a scenario (`phone.sh answer`): its run answers Asterisk's qualify
# probes, so core's Presence keeps the member registered and the ring group rings it, though its
# unconditional forwarding rule means it is never dialled itself.
log "registering and serving the one answering device"
bash "$repo/test/integration/phone.sh" "$compose" answer answer "$SIP_USERNAME" \
  "$SIP_PASSWORD" >/dev/null || fail "the device never became reachable"

log "generating the ulaw transcoding pcap"
# From the image the `sipp` service runs (compose.load.yaml's `x-sipp-image`).
python3 "$here/make_ulaw_pcap.py" "$(dc ps --format '{{.Image}}' sipp)" "$LOAD_GEN_DIR/g711u.pcap" \
  || fail "could not build the ulaw pcap"

# ---------------------------------------------------------------------------
# 3. Container ids for sampling, and disk footprint (images as pulled/built).
# ---------------------------------------------------------------------------
asterisk_id=$(dc ps -q asterisk)
core_id=$(dc ps -q core)
api_id=$(dc ps -q api)
proxy_id=$(dc ps -q proxy)
sipp_id=$(dc ps -q sipp)
sipp_phone_id=$(dc ps -q sipp-phone)
sipp_provider_id=$(dc ps -q sipp-provider)
containers=(
  "$asterisk_id=asterisk" "$core_id=core" "$api_id=api" "$proxy_id=proxy"
  "$sipp_id=sipp" "$sipp_phone_id=sipp-phone" "$sipp_provider_id=sipp-provider"
)

{
  echo '-- image sizes (docker images) --'
  docker images --format '{{.Repository}}:{{.Tag}}\t{{.Size}}' \
    | grep -E "zamfono/(asterisk|core|api|migrate):load|caddy:2|ctaloi/sipp"
  echo
  echo '-- volume sizes (the stack Compose project) --'
  stack_volume_sizes
} > "$OUT_DIR/disk-footprint-before-load.txt"

# ---------------------------------------------------------------------------
# 4. Idle step: stack up, tenant configured, one device registered, no calls.
# ---------------------------------------------------------------------------
bash "$here/run-load-step.sh" "$compose" "$OUT_DIR" idle 0 0 load-provider.xml 15 "$MAIN_DID" \
  "${containers[@]}" 2>&1 | tee -a "$OUT_DIR/session.log"

# ---------------------------------------------------------------------------
# 5. Concurrent-call load steps. rate is kept modest (5/s) so the ramp itself does not distort
#    the plateau sample. Hold is 30s (not the task's ~60s): load-caller.xml's calls last ~42s
#    (its 6 plays of the ~7s pcap), leaving roughly 30-35s of full-concurrency plateau once the
#    ramp completes, and the whole flock-held session (stack bring-up, the load steps' ramp, hold
#    and drain, the 200-endpoint bulk create, teardown) has to fit a single 10-minute Bash-tool
#    call; raise both where that budget is no constraint.
# ---------------------------------------------------------------------------
for n in 10 25 50; do
  bash "$here/run-load-step.sh" "$compose" "$OUT_DIR" "calls-$n" "$n" 5 load-provider.xml 30 \
    "$MAIN_DID" "${containers[@]}" 2>&1 | tee -a "$OUT_DIR/session.log"
done

# ---------------------------------------------------------------------------
# 6. Transcoding step: 25 calls, provider leg negotiates ulaw against the caller's alaw, forcing
#    Asterisk to transcode on the bridge (docs/spec.md §6.6's baseline is alaw/alaw, no
#    transcoding, which the calls-25 step above already measures).
# ---------------------------------------------------------------------------
bash "$here/run-load-step.sh" "$compose" "$OUT_DIR" calls-25-transcode 25 5 \
  load-provider-ulaw.xml 30 "$MAIN_DID" "${containers[@]}" 2>&1 | tee -a "$OUT_DIR/session.log"

# ---------------------------------------------------------------------------
# 7. 200-endpoint tenant: bulk-create, then time a further config change's reload, then sample
#    idle RAM with that many endpoints configured.
# ---------------------------------------------------------------------------
log "creating 200 users/devices and timing the reload"
bash "$here/bulk-users-reload.sh" "$api_base" "$token" "$phone_cidr" "$compose" "$OUT_DIR" 200 200 \
  2>&1 | tee -a "$OUT_DIR/session.log"

log "sampling idle RAM with ~200 endpoints configured"
python3 "$here/sample_tick.py" idle-200-endpoints "$OUT_DIR/stats.csv" "$OUT_DIR/net.csv" \
  "$asterisk_id=asterisk" "$core_id=core" "$api_id=api"
python3 "$here/aggregate_step.py" "$OUT_DIR/stats.csv" "$OUT_DIR/net.csv" idle-200-endpoints \
  | tee -a "$OUT_DIR/summary.txt"

{
  echo '-- volume sizes after the run (the stack Compose project) --'
  stack_volume_sizes
} > "$OUT_DIR/disk-footprint-after-load.txt"

log "session complete; results in $OUT_DIR"
cat "$OUT_DIR/summary.txt" 2>/dev/null || true
