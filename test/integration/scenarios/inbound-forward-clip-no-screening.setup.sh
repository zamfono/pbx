#!/usr/bin/env bash
# §9.4 "Forwarded calls": DID +15551078 reaches user 179, whose unconditional rule forwards to the
# external number +15557303, and DID +15551080, labelled `CI Clip Line`, has that number as its own
# target. A route ahead of the catch-all sends that number over `ci-clip`, a trunk of
# this scenario's own at the trunk container's address as its one `outbound` host (so no source
# address identifies it and the caller still arrives over `ci-trunk`), whose `diversion` is `last`
# and whose `forwardedCallerId` is `original`: each forwarded leg presents the original caller.
# 179's first DID is the number they present. Leaves the ids and the routes in place before in the
# scenario's state for the teardown.
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

trunk_id=$(api POST /trunks "{
  \"name\": \"ci-clip\",
  \"emergency\": false,
  \"authMode\": \"ip\",
  \"diversion\": \"last\",
  \"forwardedCallerId\": \"original\",
  \"hosts\": [{ \"host\": \"$(container_ip sipp)\", \"direction\": \"outbound\" }]
}" | jsonfield trunk.id)
saved=$(routes_body)
put_routes_ahead "$saved" "+15557303=$trunk_id"
printf '%s\n' "$saved" > "$(state_file inbound-forward-clip-no-screening-routes)"

forwarder=$(api POST /users \
  '{"name":"CI Clip","email":"clip@ci.test","extension":"179"}' | jsonfield user.id)
did_id=$(api POST /dids \
  "{\"number\":\"+15551078\",\"target\":{\"kind\":\"user\",\"userId\":\"$forwarder\"}}" \
  | jsonfield id)
api PUT "/users/$forwarder/forwarding" \
  '{"rules":[{"condition":"unconditional","target":{"kind":"external","external":"+15557303"}}]}' \
  >/dev/null
line_id=$(api POST /dids \
  '{"number":"+15551080","label":"CI Clip Line","target":{"kind":"external","external":"+15557303"}}' \
  | jsonfield id)
printf '%s %s %s %s\n' "$trunk_id" "$forwarder" "$did_id" "$line_id" \
  > "$(state_file inbound-forward-clip-no-screening)"
