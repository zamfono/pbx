# Sourced by `run.sh`, which calls `run_trunk_status_step` when `trunk-status` is selected
# (`only.sh`): §9.4 "Provisioning and status", trunk status "is live state the core holds in
# memory and resyncs at boot"; for an `ip` trunk it is the `qualify` reachability of its first
# host. The trunk side answers the probe and Asterisk holds `ci-trunk`'s contact reachable; `core`
# then restarts, and no `ContactStatusChange` follows, since the contact's state never changes.
# `GET /trunks` must still report the trunk `registered` from the boot resync, which `core`
# finishes before it serves anything (packages/core/src/main.ts), so before it reports healthy.
# Reads `run.sh`'s own COMPOSE, compose_args, compose and fail, and scenarios/_lib.sh's helpers.
# Self-contained and idempotent: it starts and ends its own trunk-side sipp run, the way a
# scenario does, and touches no tenant state, so REUSE may select it freely, same as a fresh run.

STATUS_ATTEMPTS=60

run_trunk_status_step() {
  echo '== §9.4 trunk status resyncs at boot =='
  local aor
  aor=trunk-$(trunk_named ci-trunk)
  $COMPOSE "${compose_args[@]}" exec -T -d sipp sh -c \
    'sh /scenarios/_sipp-run.sh trunk-status -sf /scenarios/uas/answer-outbound.xml -p 5060 -aa \
      -nostdin asterisk:5060 > /tmp/status.log 2>&1'
  if ! await_bound sipp 5060 || ! await_contact_avail "$aor"; then
    fail "the trunk's contact never became reachable before the restart"
  fi

  $COMPOSE "${compose_args[@]}" restart core >/dev/null
  local health=''
  for _ in $(seq 1 $STATUS_ATTEMPTS); do
    health=$($COMPOSE "${compose_args[@]}" ps --format '{{.Service}} {{.Health}}' \
      | awk '$1 == "core" { print $2 }')
    [ "$health" = healthy ] && break
    sleep 1
  done
  [ "$health" = healthy ] || fail "core never reported healthy after its restart"
  local trunk_status
  trunk_status=$(api GET /trunks | python3 -c "
import json, sys
print([t['status'] for t in json.load(sys.stdin)['items'] if t['name'] == 'ci-trunk'][0])
")
  [ "$trunk_status" = registered ] \
    || fail "after a core restart the reachable ip trunk reads '$trunk_status', not registered"
  $COMPOSE "${compose_args[@]}" exec -T sipp sh /scenarios/_sipp-finish.sh "$FINISH_SECONDS" \
    || fail "the trunk side's run did not end"
  echo '   the ip trunk reads registered after the restart'
}
