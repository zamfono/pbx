#!/usr/bin/env bash
# test/load/stress: the heavy-codec, recording-heavy stress measurement (docs/spec.md §6.6 sizing
# envelope, §9.1/§9.4 codecs, §10.2 call recording, §10.4 Ringotel devices). One stack, the
# same bring-up as test/load/session.sh (lib-stack.sh), then:
#   trunk side   sipp over UDP, AMR-WB only (trunk codecs ["amrwb"]): `sipp` calls in, one call
#                per user DID; `sipp-provider` is the UAS answering the devices' outbound calls
#   device side  baresip (the Ringotel stand-in): SIP over TLS to transport-tls:5061,
#                SDES-SRTP (RTP/SAVP), Opus only (settings.codecs_json ["opus"])
#   recording    users.record_calls on users 1 and 2 of every 3
# so every call is AMR-WB/UDP <-> Asterisk <-> Opus/SRTP/TLS, transcoded both ways, 2/3 of them
# with a snoop pair and a stereo mix at leg end. Steps: STEPS, tokens as lib-step.sh documents
# (0 = idle, <n> = n inbound, in:<n>:<side>, out:<n>:<side>, mix:<n_in>:<n_out>:<side>).
#
# Must run under the shared harness lock, teardown included:
#   flock /root/pbx-harness.lock bash test/load/stress/session.sh
# Knobs (environment): OUT_DIR (required), STEPS ("0 10 25 50"), DEVICES (the most users a step
# needs), PROCS (one baresip process per device; device-side hangups and outbound dials need
# that), CALL_S (90), RATE (5 calls/s per direction), TAIL_S (90), IDLE_S (60), *_IMAGE,
# HANGUP_SIDE (for bare <n> tokens: device or trunk, lib-calls.sh), COMPOSE ("docker compose" or
# "podman compose"; RUNTIME, the plain CLI, follows it).
# Images are neither built nor removed here (build them once, tagged :stress, see ci.yaml).
set -uo pipefail

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
load=$(CDPATH= cd -- "$here/.." && pwd)
repo=$(CDPATH= cd -- "$load/../.." && pwd)
COMPOSE=${COMPOSE:-docker compose}
FQDN=pbx.load.test
API_PORT=${API_PORT:-8140}
export API_PORT
API="http://127.0.0.1:$API_PORT"
MAIN_DID=+15551000
OUT_DIR=${OUT_DIR:?set OUT_DIR}
STEPS=${STEPS:-0 10 25 50}
CALL_S=${CALL_S:-90}
RATE=${RATE:-5}
TAIL_S=${TAIL_S:-90}
IDLE_S=${IDLE_S:-60}
HANGUP_SIDE=${HANGUP_SIDE:-device}
mkdir -p "$OUT_DIR"

LOAD_GEN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/zamfono-stress-gen.XXXXXX")
chmod 777 "$LOAD_GEN_DIR"
export SCENARIOS_DIR="$repo/test/integration/scenarios" LOAD_SCENARIOS_DIR="$load/scenarios"
export LOAD_GEN_DIR
export ASTERISK_IMAGE=${ASTERISK_IMAGE:-zamfono/asterisk:stress}
export MIGRATE_IMAGE=${MIGRATE_IMAGE:-zamfono/migrate:stress}
export CORE_IMAGE=${CORE_IMAGE:-zamfono/core:stress}
export API_IMAGE=${API_IMAGE:-zamfono/api:stress}
export DEVICES_IMAGE=${DEVICES_IMAGE:-zamfono/load-devices:stress}
export PROXY_IMAGE=${PROXY_IMAGE:-zamfono/proxy:stress}
METRICS_TOKEN=$(openssl rand -hex 16)
export METRICS_TOKEN

compose_files=(-f compose.yaml -f compose.ports.yaml -f "$load/compose.load.yaml"
  -f "$here/compose.stress.yaml")
# shellcheck source=test/load/lib-stack.sh
. "$load/lib-stack.sh"
# shellcheck source=test/load/stress/lib-devices.sh
. "$here/lib-devices.sh"
# shellcheck source=test/load/stress/lib-evidence.sh
. "$here/lib-evidence.sh"
# shellcheck source=test/load/stress/lib-step.sh
. "$here/lib-step.sh"
# shellcheck source=test/load/stress/lib-calls.sh
. "$here/lib-calls.sh"

if [ -z "${DEVICES:-}" ]; then
  DEVICES=0
  for token in $STEPS; do
    read -r _ n_in n_out _ <<< "$(step_parse "$token")"
    [ $(( ${n_in:-0} + ${n_out:-0} )) -gt "$DEVICES" ] && DEVICES=$(( n_in + n_out ))
  done
fi
PROCS=${PROCS:-$DEVICES}

cleanup() {
  local status=$?
  log "tearing down (exit status so far: $status)"
  if [ "$STACK_UP" = true ]; then
    dc logs --no-color asterisk 2>/dev/null | tail -n 400 > "$OUT_DIR/asterisk-tail.log" || true
    dc logs --no-color core > "$OUT_DIR/core.log" 2>/dev/null || true
    grep -iE "error|warn|fail" "$OUT_DIR/core.log" | tail -n 200 \
      > "$OUT_DIR/core-errors-tail.log" || true
    cp -r "$LOAD_GEN_DIR"/bs-* "$OUT_DIR/" 2>/dev/null || true
    dc down -v --remove-orphans >>"$OUT_DIR/session.log" 2>&1 || true
  fi
  rm -f "$repo/deploy/.env"
  rm -rf "$LOAD_GEN_DIR"
  log "teardown complete"
}
trap cleanup EXIT

# --- media for both sides, before anything is up -------------------------------------------
log "building the speech source and the AMR-WB pcap"
bash "$here/make_speech.sh" "$ASTERISK_IMAGE" "$LOAD_GEN_DIR" $((CALL_S + 40)) \
  || fail "make_speech failed"
"$RUNTIME" run --rm -v "$LOAD_GEN_DIR:/g" -v "$here:/s:ro" --entrypoint python3 "$DEVICES_IMAGE" \
  /s/make_amrwb_pcap.py /g/speech16k.wav /g/amrwb.pcap "$CALL_S" 8 octet 96 \
  2>> "$OUT_DIR/session.log" || fail "make_amrwb_pcap failed"
# The provider-side UAS answers Asterisk's own AMR-WB offer (PT 98, bandwidth-efficient).
"$RUNTIME" run --rm -v "$LOAD_GEN_DIR:/g" -v "$here:/s:ro" --entrypoint python3 "$DEVICES_IMAGE" \
  /s/make_amrwb_pcap.py /g/speech16k.wav /g/amrwb-be98.pcap "$CALL_S" 8 be 98 \
  2>> "$OUT_DIR/session.log" || fail "make_amrwb_pcap (be) failed"
cp "$here"/scenarios/stress-*.xml "$here/devices_ctrl.py" "$LOAD_GEN_DIR/"

stack_host_facts
stack_write_env
stack_up
stack_token

trunk_ip=$(dc exec -T sipp hostname -i | tr -d '\r' | awk '{print $1}')
provider_ip=$(dc exec -T sipp-provider hostname -i | tr -d '\r' | awk '{print $1}')
devices_ip=$(dc exec -T devices hostname -i | tr -d '\r' | awk '{print $1}')
log "trunk sipp=$trunk_ip provider=$provider_ip devices=$devices_ip; configuring $DEVICES users"
bash "$here/configure-stress.sh" "$API" "$TOKEN" "$trunk_ip" "$DEVICES" "$LOAD_GEN_DIR" \
  "$provider_ip" \
  2>> "$OUT_DIR/session.log" || fail "tenant configuration failed"
cp "$LOAD_GEN_DIR/recorded.txt" "$LOAD_GEN_DIR/users.txt" "$OUT_DIR/"

MEDIA_REC_DIR="$("$RUNTIME" volume inspect deploy_media --format '{{.Mountpoint}}')/recordings"
containers=()
for svc in asterisk core api proxy sipp sipp-provider devices; do
  containers+=("$(dc ps -q "$svc")=$svc")
done

dc cp asterisk:/etc/asterisk/gen/tls/cert.pem "$LOAD_GEN_DIR/asterisk-ca.pem" >/dev/null \
  || fail "could not copy the stack's TLS certificate"
log "starting $DEVICES devices in $PROCS baresip processes"
devices_start "$DEVICES" "$PROCS"
devices_await "$DEVICES"

{
  echo '--- module show like codec'; ast 'module show like codec'
  echo '--- module show like format_attr'; ast 'module show like format_attr'
  echo '--- module show like srtp'; ast 'module show like srtp'
  echo '--- core show translation paths amrwb'; ast 'core show translation paths amrwb'
  echo '--- core show translation paths opus'; ast 'core show translation paths opus'
  echo '--- pjsip show transports'; ast 'pjsip show transports'
  echo '--- device contacts'; ast 'pjsip show contacts' | grep -E 'Contact: +e[0-9]+-d' | head -8
} > "$OUT_DIR/asterisk-static.txt"

# Signalling proof: Asterisk's own decrypted view of the SIP it exchanges during the first 20 s
# of the first inbound and of the first outbound step (device legs: Via TLS, RTP/SAVP, a=crypto;
# trunk legs: the AMR-WB offer/answer), one pcap each.
captured=' '
for token in $STEPS; do
  read -r _ n_in n_out _ <<< "$(step_parse "$token")"
  kind=
  [ "${n_in:-0}" -gt 0 ] && [ "${n_out:-0}" -eq 0 ] && kind=in
  [ "${n_out:-0}" -gt 0 ] && [ "${n_in:-0}" -eq 0 ] && kind=out
  if [ -n "$kind" ] && [ "${captured#* "$kind" }" = "$captured" ]; then
    ast "pjsip set logger pcap /tmp/sip-$kind.pcap" > /dev/null
    ast 'pjsip set logger verbose off' > /dev/null
    ast 'pjsip set logger on' > /dev/null
    ( sleep 20; ast 'pjsip set logger off' > /dev/null ) &
    captured+="$kind "
  fi
  stress_step "$token"
done

# Optional diagnostics against the still-running stack (a file sourced here, not committed).
if [ -n "${POST_STEPS_HOOK:-}" ]; then
  # shellcheck disable=SC1090 -- caller-supplied
  . "$POST_STEPS_HOOK"
fi
for kind in in out; do
  dc cp "asterisk:/tmp/sip-$kind.pcap" "$OUT_DIR/sip-$kind.pcap" >/dev/null 2>&1 || true
done
{
  echo '-- volume sizes after the run --'
  stack_volume_sizes
  echo '-- recordings dir --'
  find "$MEDIA_REC_DIR" -name '*.wav' -printf '%s %f\n' 2>/dev/null | sort -n | tail -5
} > "$OUT_DIR/disk-after.txt"
log "session complete; results in $OUT_DIR"
