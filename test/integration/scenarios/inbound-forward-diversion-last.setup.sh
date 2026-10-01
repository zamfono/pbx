#!/usr/bin/env bash
# §9.4 "Forwarded calls": a DID reaches user 177, whose out-of-office rule forwards to user 178,
# whose unconditional rule forwards to the external number +15557301. A route ahead of the
# catch-all sends that number over `ci-divert-last`, a trunk of this scenario's own at the trunk
# container's address as its one `outbound` host (so no source address identifies it and the
# caller still arrives over `ci-trunk`), whose `diversion` is `last`: the forwarded leg's INVITE
# carries the newest hop alone. `ci-trunk` keeps its `off`, which the other scenarios rely on.
# Leaves the ids and the routes in place before in the scenario's state for the teardown.
set -euo pipefail

api_base=$1
token=$2
compose=$4
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

trunk_id=$(api POST /trunks "{
  \"name\": \"ci-divert-last\",
  \"emergency\": false,
  \"authMode\": \"ip\",
  \"diversion\": \"last\",
  \"hosts\": [{ \"host\": \"$(container_ip sipp)\", \"direction\": \"outbound\" }]
}" | jsonfield trunk.id)
saved=$(routes_body)
put_routes_ahead "$saved" "+15557301=$trunk_id"
printf '%s\n' "$saved" > "$(state_file inbound-forward-diversion-last-routes)"

forwarder=$(api POST /users \
  '{"name":"CI Away","email":"away@ci.test","extension":"177"}' | jsonfield user.id)
agent=$(api POST /users \
  '{"name":"CI Agent","email":"agent@ci.test","extension":"178"}' | jsonfield user.id)
did_id=$(api POST /dids \
  "{\"number\":\"+15551077\",\"target\":{\"kind\":\"user\",\"userId\":\"$forwarder\"}}" \
  | jsonfield id)
api POST "/users/$forwarder/ooo" \
  "{\"active\":true,\"target\":{\"kind\":\"user\",\"userId\":\"$agent\"}}" >/dev/null
api PUT "/users/$agent/forwarding" \
  '{"rules":[{"condition":"unconditional","target":{"kind":"external","external":"+15557301"}}]}' \
  >/dev/null
printf '%s %s %s %s\n' "$trunk_id" "$forwarder" "$agent" "$did_id" \
  > "$(state_file inbound-forward-diversion-last)"
