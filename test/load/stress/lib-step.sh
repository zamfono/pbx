#!/usr/bin/env bash
# test/load/stress: one load step of the heavy-codec profile (sourced by stress/session.sh after
# lib-stack.sh, lib-evidence.sh, lib-calls.sh). A step token (STEPS) is one of
#   0                        idle
#   <n>                      n inbound calls, ended by HANGUP_SIDE
#   in:<n>:<side>            n inbound calls (trunk sipp -> users 1..n, AMR-WB -> TLS/SRTP/Opus)
#   out:<n>:<side>           n outbound calls (devices 1..n -> trunk -> provider sipp UAS)
#   mix:<n_in>:<n_out>:<side>  both at once: inbound to users 1..n_in, outbound from the next n_out
# with <side> device or trunk (who hangs up, lib-calls.sh). A 1 s cgroup sampler runs from before
# the ramp until well after the drain, labelled by phase:
#   ramp    -- calls being set up, until 2(n_in + n_out) PJSIP legs are up
#   plateau -- full concurrency, until the first call ends
#   drain   -- calls ending (and their recordings being mixed), until no PJSIP leg is left
#   tail    -- after the last leg, until every expected recordings row exists (max TAIL_S),
#              so a mix that runs after the leg is gone is still inside the sampled window
# Expects: CALL_S, RATE, TAIL_S, IDLE_S, HANGUP_SIDE, containers (array of id=label),
# LOAD_GEN_DIR, MEDIA_REC_DIR, OUT_DIR.
# shellcheck shell=bash

step_phase() { echo "$1" > "$STEP_DIR/phase"; echo "$(date -u +%T) phase $1" >> "$STEP_DIR/step.log"; }

# Prints "<name> <n_in> <n_out> <side>" for a step token; the users a step needs is n_in + n_out.
step_parse() {
  local IFS=: t
  read -r -a t <<< "$1"
  case "${t[0]}" in
    0) echo "idle 0 0 none" ;;
    in) echo "in-${t[1]}-${t[2]} ${t[1]} 0 ${t[2]}" ;;
    out) echo "out-${t[1]}-${t[2]} 0 ${t[1]} ${t[2]}" ;;
    mix) echo "mix-${t[1]}+${t[2]}-${t[3]} ${t[1]} ${t[2]} ${t[3]}" ;;
    *[!0-9]*) return 1 ;;
    *) echo "in-${t[0]}-$HANGUP_SIDE ${t[0]} 0 $HANGUP_SIDE" ;;
  esac
}

# Recorded participations among users <first>+1 .. <first>+<count>.
step_expected() {
  [ "$2" -gt 0 ] || { echo 0; return; }
  sed -n "$(($1 + 1)),$(($1 + $2))p" "$LOAD_GEN_DIR/recorded.txt" | grep -c 1
}

stress_step() {
  local step n_in n_out side
  read -r step n_in n_out side <<< "$(step_parse "$1")"
  [ -n "$side" ] || fail "bad step token: $1"
  STEP_DIR="$OUT_DIR/$step"
  mkdir -p "$STEP_DIR"
  # A fresh access token per step: one lives 15 min (ACCESS_TOKEN_TTL_S), a session far longer.
  stack_token
  log "step $step: $n_in inbound + $n_out outbound, ${CALL_S}s each, rate ${RATE}/s, $side hangs up"
  step_phase pre
  python3 "$here/cg_sampler.py" "$STEP_DIR/samples.csv" "$STEP_DIR/phase" "$STEP_DIR/stop" 1 \
    "${containers[@]}" &
  local sampler=$!
  local rec_before fail_before expected
  rec_before=$(recordings_count)
  fail_before=$(mix_failures)
  expected=$(( $(step_expected 0 "$n_in") + $(step_expected "$n_in" "$n_out") ))
  recordings_dump "$STEP_DIR/recordings-before.json"
  {
    echo "step=$step n_in=$n_in n_out=$n_out hangup_side=$side"
    echo "recordings_before=$rec_before mix_failures_before=$fail_before expected_recorded=$expected"
    echo "media_before: $(media_sizes)"
  } >> "$STEP_DIR/summary.txt"
  local since
  since=$(date -u +%FT%TZ)
  sleep 5

  if [ "$n_in" -eq 0 ] && [ "$n_out" -eq 0 ]; then
    step_phase plateau
    evidence_legs "$STEP_DIR/evidence.txt"
    sleep "$IDLE_S"
  else
    step_run_calls "$step" "$n_in" "$n_out" "$side"
  fi

  step_phase done
  touch "$STEP_DIR/stop"
  wait "$sampler"
  local rec_after fail_after groups=()
  rec_after=$(recordings_count)
  fail_after=$(mix_failures)
  recordings_dump "$STEP_DIR/recordings.json"
  [ "$n_in" -gt 0 ] && groups+=("in-$side:0:$n_in")
  [ "$n_out" -gt 0 ] && groups+=("out-$side:$n_in:$n_out")
  {
    local new_rows='?'
    [[ "$rec_after$rec_before" =~ ^[0-9]+$ ]] && new_rows=$(( rec_after - rec_before ))
    echo "recordings_after=$rec_after new_rows=$new_rows expected=$expected"
    [ "${#groups[@]}" -gt 0 ] && python3 "$here/step_recordings.py" \
      "$STEP_DIR/recordings-before.json" "$STEP_DIR/recordings.json" "$LOAD_GEN_DIR/users.txt" \
      "$LOAD_GEN_DIR/recorded.txt" "$MEDIA_REC_DIR" "${groups[@]}"
    echo "mix_failures_after=$fail_after"
    echo "media_after: $(media_sizes)"
    echo "core_log_recording_lines: $(dc logs --since "$since" core 2>/dev/null | grep -ciE 'recording (could not start|mix failed)')"
  } >> "$STEP_DIR/summary.txt"
  dc logs --since "$since" core 2>/dev/null | grep -iE 'mix|record' | grep -iE 'fail|error|warn' \
    | head -50 > "$STEP_DIR/core-recording-errors.log" || true
  python3 "$here/cg_aggregate.py" "$STEP_DIR/samples.csv" "$STEP_DIR/aggregate.json" \
    > "$STEP_DIR/aggregate.txt"
  cat "$STEP_DIR/summary.txt" "$STEP_DIR/aggregate.txt" | tee -a "$OUT_DIR/summary.txt" >&2
}

step_run_calls() {
  local step=$1 n_in=$2 n_out=$3 side=$4 target=$(( ($2 + $3) * 2 ))
  step_phase ramp
  local up=0 reached=false t_ramp
  t_ramp=$(date +%s)
  calls_start "$step" "$n_in" "$n_out" "$side"
  for _ in $(seq 1 $(( (n_in + n_out) / RATE + 60 ))); do
    up=$(pjsip_channels)
    [ "${up:-0}" -ge "$target" ] && { reached=true; break; }
    sleep 1
  done
  echo "ramp_reached=$reached pjsip_legs=$up target=$target ramp_s=$(( $(date +%s) - t_ramp ))" \
    >> "$STEP_DIR/summary.txt"

  step_phase plateau
  sleep 10
  evidence_legs "$STEP_DIR/evidence.txt"
  echo "plateau+10s: $(media_sizes)" >> "$STEP_DIR/media-progress.txt"
  local t_plateau min=$target
  t_plateau=$(date +%s)
  while :; do
    up=$(pjsip_channels)
    [ "${up:-0}" -lt "$min" ] && min=$up
    echo "$(date -u +%T) pjsip_legs=$up snoops=$(snoop_channels) $(media_sizes)" \
      >> "$STEP_DIR/media-progress.txt"
    # The plateau ends when the first call does (allow one leg of slack for a ramp stray).
    [ "${up:-0}" -lt $((target - 2)) ] && break
    [ $(( $(date +%s) - t_plateau )) -gt $((CALL_S + 120)) ] && break
    sleep 5
  done
  echo "plateau_s=$(( $(date +%s) - t_plateau + 10 )) plateau_min_legs=$min" >> "$STEP_DIR/summary.txt"

  step_phase drain
  for _ in $(seq 1 240); do
    [ "$(pjsip_channels)" = 0 ] && break
    sleep 1
  done
  echo "drained_legs=$(pjsip_channels) snoops_left=$(snoop_channels)" >> "$STEP_DIR/summary.txt"

  step_phase tail
  local want=$(( rec_before + expected )) have
  for _ in $(seq 1 "$TAIL_S"); do
    have=$(recordings_count)
    [ "${have:-0}" -ge "$want" ] 2>/dev/null && break
    sleep 1
  done
  sleep 5
  calls_collect "$step" "$n_in" "$n_out"
}
