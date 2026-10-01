#!/usr/bin/env bash
# §10.1 "Emergency calls", §9.4 "Trunk order", "Emergency trunks": three trunks to the second
# provider ahead of `ci-trunk` in the trunk order, each at its own port there with a sipp process
# of its own tracing what it receives, so every trunk is observed apart:
#
#   1  ci-em-refuse  emergency, :5061, refuses every INVITE with 503 (`uas/refuse-503.xml`)
#   2  ci-em-plain   not emergency, :5062, would answer (`uas/answer-outbound.xml`)
#   3  ci-em-answer  emergency, :5063, answers (`uas/answer-outbound.xml`)
#   4  ci-trunk      emergency, the harness's own trunk and the catch-all route's
#
# All four answer their qualify, so none is `unreachable`. The trunk order and `ci-trunk` as they
# were before are kept for the teardown to put back and compare against.
set -euo pipefail

api_base=$1
token=$2
compose=$4
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

STATUS_ATTEMPTS=30

# shellcheck disable=SC2086 # `$compose` carries the runtime's own multi-word command
$compose exec -T sipp-provider sh -c 'rm -f /tmp/emergency-*.log'
for side in 1:5061:refuse-503 2:5062:answer-outbound 3:5063:answer-outbound; do
  IFS=: read -r n port uas <<<"$side"
  # shellcheck disable=SC2086
  $compose exec -T -d sipp-provider sh -c \
    "sh /scenarios/_sipp-run.sh provider-emergency-$n -sf /scenarios/uas/$uas.xml -p $port -aa \
      -nostdin -trace_msg -message_file /tmp/emergency-$n-messages.log asterisk:5060 \
      > /tmp/emergency-$n.log 2>&1"
  await_bound sipp-provider "$port"
done

# The one catch-all route the harness configured must be `ci-trunk`'s, or the control call
# proves nothing about the trunk the emergency call must pass by.
ci_id=$(trunk_named ci-trunk)
api GET /outboundRoutes | python3 -c '
import json, sys
routes = json.load(sys.stdin)["items"]
if not routes or routes[-1]["trunkId"] != sys.argv[1] or routes[-1]["numbers"]:
    sys.exit("the last outbound route is not a catch-all over ci-trunk: " + json.dumps(routes))
' "$ci_id"

provider_ip=$(container_ip sipp-provider)
new_trunk() {
  api POST /trunks "{
    \"name\": \"$1\",
    \"emergency\": $2,
    \"authMode\": \"ip\",
    \"hosts\": [{ \"host\": \"$provider_ip\", \"port\": $3, \"direction\": \"outbound\" }]
  }" | jsonfield trunk.id
}
saved_order=$(api GET /trunks | python3 -c '
import json, sys
print(json.dumps([t["id"] for t in json.load(sys.stdin)["items"]]))
')
ci_before=$(trunk_snapshot "$ci_id")
refuse_id=$(new_trunk ci-em-refuse true 5061)
plain_id=$(new_trunk ci-em-plain false 5062)
answer_id=$(new_trunk ci-em-answer true 5063)
printf '%s %s %s %s\n' "$refuse_id" "$plain_id" "$answer_id" "$ci_id" \
  > "$(state_file emergency-order)"
printf '%s\n' "$saved_order" > "$(state_file emergency-order-saved)"
printf '%s\n' "$ci_before" > "$(state_file emergency-order-ci)"

api PUT /trunks/order "$(python3 -c '
import json, sys
print(json.dumps({"trunkIds": sys.argv[1:4] + json.loads(sys.argv[4])}))
' "$refuse_id" "$plain_id" "$answer_id" "$saved_order")" >/dev/null

# The core skips an `unreachable` trunk and tries an `unknown` one, so each of the three is
# probed, by the runs above, which answer, and the call waits until the core itself reports
# each reachable (§9.4 "Provisioning and status"): the assertion that trunk 2 was passed by is
# then about its flag, not its status.
for id in "$refuse_id" "$plain_id" "$answer_id"; do
  await_contact_avail "trunk-$id"
done
for attempt in $(seq 1 $STATUS_ATTEMPTS); do
  if api GET /trunks | python3 -c '
import json, sys
status = {t["id"]: t["status"] for t in json.load(sys.stdin)["items"]}
sys.exit(0 if all(status.get(id) == "registered" for id in sys.argv[1:]) else 1)
' "$refuse_id" "$plain_id" "$answer_id"; then
    exit 0
  fi
  sleep 1
done
echo "the emergency scenario's trunks never read registered after $attempt attempts" >&2
exit 1
