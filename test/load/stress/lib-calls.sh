#!/usr/bin/env bash
# test/load/stress: starts and ends one step's calls (sourced by stress/session.sh after
# lib-stack.sh). A step is <n_in> inbound plus <n_out> outbound calls, all ended by <side>:
#   inbound   the trunk-side sipp (container `sipp`) calls users 1..n_in, one DID each
#             (stress-caller.xml; stress-caller-bye.xml when the trunk side hangs up)
#   outbound  devices n_in+1..n_in+n_out dial out over ctrl_tcp (devices_ctrl.py dial); the
#             catch-all route sends them over the AMR-WB trunk to the provider-side sipp UAS
#             (container `sipp-provider`: stress-uas.xml; stress-uas-bye.xml when it hangs up)
#   side      device: each device ends its own call CALL_S after it started (devices_ctrl.py
#             hangup, spaced like the ramp); trunk: the external sipp ends it (a <pause/> of
#             sipp's -d, then BYE) -- for inbound that is the caller hanging up first, for
#             outbound the called party
# Every device has its own baresip process (PROCS = DEVICES), so device i's ctrl_tcp port is
# 4000 + i - 1. Expects: CALL_S, RATE, STEP_DIR, LOAD_GEN_DIR.
# shellcheck shell=bash

OUT_NUMBER_PREFIX=+1555800   # outbound call i dials +1555800<iii>
DEVICE_DOMAIN=zamfono:5061     # baresip adds the account's own ;transport=tls

calls_start() {
  local step=$1 n_in=$2 n_out=$3 side=$4 caller=stress-caller.xml uas=stress-uas.xml
  if [ "$side" = trunk ]; then caller=stress-caller-bye.xml; uas=stress-uas-bye.xml; fi
  if [ "$n_out" -gt 0 ]; then
    # The UAS listens before any device dials. -aa answers Asterisk's qualify OPTIONS to the
    # trunk host (otherwise each is an aborted "call"); no -m, since those OPTIONS would count
    # towards it -- calls_collect stops it.
    dc exec -T -d sipp-provider sh -c \
      "rm -f /tmp/u-$step.exit; sipp -sf /load-gen/$uas -p 5060 -aa \
        -d $((CALL_S * 1000)) -min_rtp_port 30000 -max_rtp_port 39999 \
        -timeout $((CALL_S + 240))s -trace_stat -stf /tmp/u-$step.csv \
        -trace_err -error_file /tmp/u-$step-errors.log -nostdin \
        > /tmp/u-$step.stdout 2>&1; echo \$? > /tmp/u-$step.exit"
    calls_trunk_reachable
  fi
  if [ "$n_in" -gt 0 ]; then
    dc exec -T -d sipp sh -c \
      "rm -f /tmp/c-$step.exit; sipp -sf /load-gen/$caller -inf /load-gen/dids.csv \
        -l $n_in -m $n_in -r $RATE -rp 1s -d $((CALL_S * 1000)) \
        -min_rtp_port 20000 -max_rtp_port 29999 -timeout $((CALL_S + 240))s \
        -trace_stat -stf /tmp/c-$step.csv -trace_err -error_file /tmp/c-$step-errors.log \
        -nostdin asterisk:5060 > /tmp/c-$step.stdout 2>&1; echo \$? > /tmp/c-$step.exit"
  fi
  local interval
  interval=$(python3 -c "print(1 / $RATE)")
  if [ "$n_out" -gt 0 ]; then
    dc exec -T devices python3 /load-gen/devices_ctrl.py dial $((4000 + n_in)) "$n_out" \
      "$interval" "$OUT_NUMBER_PREFIX" "$DEVICE_DOMAIN" > "$STEP_DIR/dial.log" 2>&1 &
  fi
  if [ "$side" != trunk ]; then
    # Device-side hangups, CALL_S after each call's own start (the ramp's own spacing).
    [ "$n_in" -gt 0 ] && ( sleep "$CALL_S"; dc exec -T devices python3 \
      /load-gen/devices_ctrl.py hangup 4000 "$n_in" "$interval" > "$STEP_DIR/hangup-in.log" 2>&1 ) &
    [ "$n_out" -gt 0 ] && ( sleep "$CALL_S"; dc exec -T devices python3 \
      /load-gen/devices_ctrl.py hangup $((4000 + n_in)) "$n_out" "$interval" \
      > "$STEP_DIR/hangup-out.log" 2>&1 ) &
  fi
  return 0
}

# Asterisk qualifies the trunk's outbound host, and the stack does not route a call to a host it
# last saw unreachable (between outbound steps nothing answers there). So once the UAS listens,
# qualify it on demand and wait for the contact to read Avail before any device dials.
calls_trunk_qualified() {
  ast "pjsip qualify $1" > /dev/null
  sleep 1
  ast 'pjsip show contacts' | grep -E "Contact: +$1/" | grep -q Avail
}

calls_trunk_reachable() {
  local ep started=$SECONDS
  ep=$(ast 'pjsip show endpoints' | awk '$1 == "Endpoint:" && $2 ~ /^trunk-/ { print $2; exit }')
  ep=${ep%%/*}
  if poll 20 0 calls_trunk_qualified "$ep"; then
    echo "trunk $ep reachable after $((SECONDS - started))s" >> "$STEP_DIR/summary.txt"
    sleep 2
    return 0
  fi
  echo "trunk $ep NOT reachable: $(ast 'pjsip show contacts' | grep -E "Contact: +$ep/")" \
    >> "$STEP_DIR/summary.txt"
}

# Collects both sipp sides' own view of the step, then stops whatever is left of them.
calls_collect() {
  local step=$1 n_in=$2 n_out=$3
  if [ "$n_in" -gt 0 ]; then
    dc exec -T sipp sh -c "cat /tmp/c-$step.exit 2>/dev/null; tail -n 25 /tmp/c-$step.stdout" \
      > "$STEP_DIR/sipp-caller.txt" 2>&1 || true
    dc exec -T sipp sh -c "head -c 4000 /tmp/c-$step-errors.log" \
      > "$STEP_DIR/sipp-errors.txt" 2>&1 || true
  fi
  if [ "$n_out" -gt 0 ]; then
    dc exec -T sipp-provider sh -c \
      "cat /tmp/u-$step.exit 2>/dev/null; tail -n 25 /tmp/u-$step.stdout" \
      > "$STEP_DIR/sipp-uas.txt" 2>&1 || true
    dc exec -T sipp-provider sh -c "head -c 4000 /tmp/u-$step-errors.log" \
      > "$STEP_DIR/sipp-uas-errors.txt" 2>&1 || true
  fi
  dc exec -T sipp pkill sipp >/dev/null 2>&1 || true
  dc exec -T sipp-provider pkill sipp >/dev/null 2>&1 || true
}
