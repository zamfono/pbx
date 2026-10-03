#!/usr/bin/env bash
# test/load/stress: the device side (Ringotel stand-ins). Sourced by stress/session.sh after
# lib-stack.sh (uses dc, log, fail). Splits the tenant's devices across <procs> baresip
# processes inside the one `devices` container (each its own SIP port and config directory under
# /load-gen), so one process's main loop never has to carry every call's Opus encode + SRTP; the
# container as a whole is the load generator's cost.
#
# Every account registers once over TLS and stays up for the whole session: baresip answers
# Asterisk's qualify OPTIONS itself, which is what keeps core's Presence seeing the device as
# available (the one-shot-register decay test/load/session.sh documents cannot happen here).
# shellcheck shell=bash

devices_start() {
  local count=$1 procs=$2 per first p
  per=$(( (count + procs - 1) / procs ))
  for p in $(seq 0 $((procs - 1))); do
    first=$((p * per))
    [ "$first" -ge "$count" ] && break
    python3 "$here/gen_baresip.py" "$LOAD_GEN_DIR/creds.csv" "$LOAD_GEN_DIR/bs-$p" "$first" \
      "$per" $((5080 + p)) /load-gen/speech48k.wav || fail "gen_baresip failed"
    dc exec -T -d devices sh -c \
      "baresip -f /load-gen/bs-$p > /load-gen/bs-$p/baresip.log 2>&1"
  done
}

# Contacts of this tenant's devices that Asterisk currently reads as reachable.
devices_available() {
  asterisk_cli 'pjsip show contacts' 2>/dev/null \
    | awk '$1 == "Contact:" && $2 ~ /^e[0-9]+-d/ && /Avail/' | wc -l
}

# Whether `$1` devices are reachable, the count left in `n`; else qualifies the first `$1`'s AORs
# now, sparing their own qualify interval, the way phone.sh does (one exec for all of them).
devices_reachable() {
  n=$(devices_available)
  [ "$n" -ge "$1" ] && return
  dc exec -T asterisk sh -c \
    "for u in $users; do asterisk -rx \"pjsip qualify \$u\"; done" >/dev/null 2>&1 || true
  return 1
}

devices_await() {
  local count=$1 n=0 users
  users=$(head -n "$count" "$LOAD_GEN_DIR/creds.csv" | cut -d, -f1 | tr '\n' ' ')
  poll 60 3 devices_reachable "$count" || true
  log "devices reachable: $n/$count"
  [ "$n" -ge "$count" ] || fail "only $n of $count devices became reachable"
}
