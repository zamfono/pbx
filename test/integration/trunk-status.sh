# Sourced by `run.sh`, which calls `run_trunk_status_step` when `trunk-status` is selected
# (`only.sh`): §9.4 "Provisioning and status", trunk status "is live state the core holds in
# memory and resyncs at boot"; for an `ip` trunk it is the `qualify` reachability of its first
# host. The trunk side answers the probe and Asterisk holds the contact reachable; `core` then
# restarts, and no `ContactStatusChange` follows, since the contact's state never changes.
# `GET /trunks` must still report the trunk `registered` from the boot resync.
# Reads `run.sh`'s own COMPOSE, compose_args, api and fail. Self-contained and idempotent: it
# starts and stops its own trunk-side sipp process and touches no tenant state, so REUSE may
# select it freely, same as a fresh run.

STATUS_ATTEMPTS=60

run_trunk_status_step() {
  echo '== §9.4 trunk status resyncs at boot =='
  $COMPOSE "${compose_args[@]}" exec -T sipp sh -c 'pkill sipp || true'
  $COMPOSE "${compose_args[@]}" exec -T -d sipp sh -c \
    'sipp -sf /scenarios/uas/answer-outbound.xml -p 5060 -aa -nostdin asterisk:5060 > /tmp/status.log 2>&1'
  local trunk_endpoint
  # awk reads the whole list and keeps the first match: an `exit` on it closes the pipe early,
  # and under pipefail Podman's compose provider reports the CLI's SIGPIPE as a failure.
  trunk_endpoint=$($COMPOSE "${compose_args[@]}" exec -T asterisk asterisk -rx 'pjsip show contacts' \
    | awk '!found && $1 == "Contact:" && $2 ~ /^trunk-/ { split($2, parts, "/"); print parts[1]; found = 1 }')
  local reachable=false
  for _ in $(seq 1 $STATUS_ATTEMPTS); do
    $COMPOSE "${compose_args[@]}" exec -T asterisk asterisk -rx "pjsip qualify $trunk_endpoint" \
      >/dev/null 2>&1 || true
    sleep 1
    if $COMPOSE "${compose_args[@]}" exec -T asterisk asterisk -rx 'pjsip show contacts' \
      | grep "$trunk_endpoint/.*Avail" >/dev/null; then
      reachable=true
      break
    fi
  done
  [ "$reachable" = true ] || fail "the trunk's contact never became reachable before the restart"

  $COMPOSE "${compose_args[@]}" restart core >/dev/null
  local trunk_status=unknown
  for _ in $(seq 1 $STATUS_ATTEMPTS); do
    trunk_status=$(api GET /trunks 2>/dev/null | python3 -c "
import json, sys
print([t['status'] for t in json.load(sys.stdin)['items'] if t['name'] == 'ci-trunk'][0])
" 2>/dev/null) || trunk_status=unknown
    [ "$trunk_status" = registered ] && break
    sleep 1
  done
  [ "$trunk_status" = registered ] \
    || fail "after a core restart the reachable ip trunk reads '$trunk_status', not registered"
  $COMPOSE "${compose_args[@]}" exec -T sipp sh -c 'pkill sipp || true'
  echo '   the ip trunk reads registered after the restart'
}
