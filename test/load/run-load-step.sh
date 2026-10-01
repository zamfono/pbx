#!/usr/bin/env bash
# test/load: runs one concurrent-call load step (docs/spec.md §6.6 "Sizing envelope") and samples
# `docker stats` + host veth byte counters through the plateau. Two-leg bridged calls only: the
# ring group answers the caller leg immediately (MOH) while the sole member's unconditional
# forward dials the second leg out over the trunk to sipp-provider, so N concurrent calls is 2N
# Asterisk channels and, at rtcp_mux off (images/asterisk/conf/rtp.conf.tmpl does not enable it),
# up to 4N RTP/RTCP ports against the RTP_PORT_START..RTP_PORT_END range in .env.
#
# Usage: run-load-step.sh <compose_cmd> <out_dir> <step_name> <concurrency> <rate_per_s> \
#          <provider_scenario.xml> <hold_seconds> <main_did> <container-id=label> ...
#
# Deliberately not `set -e`: a transient `docker exec` hiccup under a heavy plateau (asterisk busy
# relaying 100 RTP streams) must not silently abort the whole step and skip its teardown. Every
# step still reports what it actually reached (ramp_reached, plateau_end_channels, drained in
# <step>-summary.txt) rather than assuming success.
set -uo pipefail

compose_cmd=$1; shift
out_dir=$1; shift
step=$1; shift
concurrency=$1; shift
rate=$1; shift
provider_xml=$1; shift
hold_seconds=$1; shift
main_did=$1; shift
# Remaining args: "container_id=label" pairs, the containers to sample this step.
container_specs=("$@")
container_ids=()
for spec in "${container_specs[@]}"; do
  container_ids+=("${spec%%=*}")
done

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# The contact waits the integration harness's scenarios use, on this step's stack.
compose=$compose_cmd
# shellcheck source=../integration/scenarios/_lib.sh
. "$here/../integration/scenarios/_lib.sh"
mkdir -p "$out_dir"
stats_csv="$out_dir/stats.csv"
net_csv="$out_dir/net.csv"
step_log="$out_dir/$step.log"

dc() {
  # shellcheck disable=SC2086 # $compose_cmd carries the runtime's own multi-word command
  $compose_cmd "$@"
}

asterisk_cli() {
  dc exec -T asterisk asterisk -rx "$1"
}

channels_up() {
  asterisk_cli 'core show channels count' 2>/dev/null \
    | awk '/active channels/ { print $1; found=1 } END { if (!found) print 0 }'
}

echo "== $step: concurrency=$concurrency rate=$rate/s hold=${hold_seconds}s provider=$provider_xml ==" \
  | tee -a "$step_log" >&2

# A clean slate: nothing left running from a previous step.
dc exec -T sipp-provider pkill sipp >/dev/null 2>&1 || true
dc exec -T sipp pkill sipp >/dev/null 2>&1 || true
sleep 1

if [ "$concurrency" -gt 0 ]; then
  # The provider listens for every forwarded leg this step throws at it, unlimited concurrency
  # (no -l/-m; matches test/integration/run-scenarios.sh's own start_trunk_side pattern), auto-
  # answering and replaying the step's pcap on each one.
  dc exec -T -d sipp-provider sh -c \
    "rm -f /tmp/provider-$step.exit; sipp -sf /load-scenarios/$provider_xml -p 5060 -aa -nostdin \
      -min_rtp_port 30000 -max_rtp_port 40999 \
      -trace_msg -message_file /tmp/provider-$step-messages.log \
      asterisk:5060 > /tmp/provider-$step.stdout 2>&1; echo \$? > /tmp/provider-$step.exit"

  # Reachable before the caller starts dialling (the trunk's own qualify, the wait
  # run-scenarios.sh's start_trunk_side makes), once the provider answers its probe.
  await_bound sipp-provider 5060
  contacts=$(asterisk_cli 'pjsip show contacts')
  for aor in $(printf '%s\n' "$contacts" \
    | awk '$1 == "Contact:" && $2 ~ /^trunk-/ { split($2, aor, "/"); print aor[1] }'); do
    await_contact_avail "$aor" 'Avail|NonQual'
  done


  dc exec -T -d sipp sh -c \
    "rm -f /tmp/caller-$step.exit; sipp -sf /load-scenarios/load-caller.xml -s '$main_did' \
      -l $concurrency -m $concurrency -r $rate -rp 1s \
      -min_rtp_port 20000 -max_rtp_port 29999 -timeout 180s \
      -trace_stat -stf /tmp/caller-$step.csv \
      -trace_msg -message_file /tmp/caller-$step-messages.log \
      -nostdin asterisk:5060 > /tmp/caller-$step.stdout 2>&1; echo \$? > /tmp/caller-$step.exit"

  echo "-- ramping to $concurrency concurrent calls" >&2
  target=$((concurrency * 2))
  ramp_timeout=$(( concurrency / (rate > 0 ? rate : 1) + 30 ))
  reached=false
  for _ in $(seq 1 "$ramp_timeout"); do
    up=$(channels_up)
    if [ "${up:-0}" -ge "$target" ]; then
      reached=true
      break
    fi
    sleep 1
  done
  up=$(channels_up)
  echo "-- ramp finished: $up/$target channels up (reached=$reached)" | tee -a "$step_log" >&2
  echo "ramp_reached=$reached ramp_channels=$up ramp_target=$target" >> "$out_dir/$step-summary.txt"
else
  up=$(channels_up)
  echo "-- idle: $up channels up" | tee -a "$step_log" >&2
fi

echo "-- sampling for ${hold_seconds}s (every 5s)" >&2
ticks=$(( hold_seconds / 5 ))
[ "$ticks" -lt 1 ] && ticks=1
mid=$(( ticks / 2 ))
for i in $(seq 1 "$ticks"); do
  python3 "$here/sample_tick.py" "$step" "$stats_csv" "$net_csv" "${container_specs[@]}" \
    || echo "   a sample tick failed (continuing)" >&2
  # Mid-plateau proof that real RTP is actually flowing through asterisk, not just that channels
  # are up: per-channel RTP packet/byte counters, captured once so the log stays short.
  if [ "$concurrency" -gt 0 ] && [ "$i" -eq "$mid" ]; then
    {
      echo "--- rtp evidence at tick $i/$ticks ---"
      asterisk_cli 'core show channels verbose' 2>/dev/null | head -6
      for ch in $(asterisk_cli 'core show channels concise' 2>/dev/null | cut -d'!' -f1 | head -2); do
        echo "channel $ch:"
        asterisk_cli "core show channel $ch" 2>/dev/null | grep -iE 'rtp|codec|format|read|write'
      done
    } >> "$out_dir/$step-rtp-evidence.txt" 2>&1
  fi
  sleep 5
done

final_channels=$(channels_up)
echo "plateau_end_channels=$final_channels" >> "$out_dir/$step-summary.txt"
echo "-- plateau end: $final_channels channels up" | tee -a "$step_log" >&2

if [ "$concurrency" -gt 0 ]; then
  echo '-- waiting for the caller run to finish (drain)' >&2
  for _ in $(seq 1 240); do
    if code=$(dc exec -T sipp cat "/tmp/caller-$step.exit" 2>/dev/null); then
      echo "   caller sipp exit: $(printf '%s' "$code" | tr -d '\r')" | tee -a "$step_log" >&2
      break
    fi
    sleep 1
  done
fi

echo '-- waiting for channels to drain to 0' >&2
drained=false
for _ in $(seq 1 60); do
  n=$(channels_up)
  if [ "${n:-1}" = 0 ]; then
    drained=true
    break
  fi
  sleep 1
done
echo "drained=$drained" >> "$out_dir/$step-summary.txt"
[ "$drained" = true ] || echo "WARNING: channels did not drain to 0 after $step" | tee -a "$step_log" >&2

dc exec -T sipp-provider pkill sipp >/dev/null 2>&1 || true
dc exec -T sipp pkill sipp >/dev/null 2>&1 || true

python3 "$here/aggregate_step.py" "$stats_csv" "$net_csv" "$step" | tee -a "$out_dir/summary.txt"
