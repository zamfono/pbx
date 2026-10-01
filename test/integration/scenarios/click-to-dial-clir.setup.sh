#!/usr/bin/env bash
# §10.2 "Click-to-dial" with the call's own CLIR (§9.4 "Anonymous calls (CLIR)"): a trunk
# `ci-clir` beside `ci-trunk`, at the trunk container's address as its one `outbound` host, whose
# caller-ID layout `both` carries a withheld call (an anonymous From, the number in
# P-Asserted-Identity), and a route ahead of the catch-all that sends `+15557102` over it. The
# routes in place before are kept for the teardown to put back.
set -euo pipefail

api_base=$1
token=$2
compose=$4
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

trunk_id=$(api POST /trunks "{
  \"name\": \"ci-clir\",
  \"emergency\": false,
  \"authMode\": \"ip\",
  \"callerIdHeader\": \"both\",
  \"hosts\": [{ \"host\": \"$(container_ip sipp)\", \"direction\": \"outbound\" }]
}" | jsonfield trunk.id)
saved=$(routes_body)
put_routes_ahead "$saved" "+15557102=$trunk_id"
printf '%s\n' "$trunk_id" > "$(state_file clir-trunk)"
printf '%s\n' "$saved" > "$(state_file clir-routes)"
