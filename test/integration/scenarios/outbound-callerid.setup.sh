#!/usr/bin/env bash
# §9.4 "Caller-ID": two trunks next to `ci-trunk` (a `from` trunk), each at the trunk container's
# address as its one `outbound` host, so no source address identifies them: `ci-pai`, whose
# account identity is `ci-pai-acct` (an `ip` trunk has a username only with `inbound_auth`), and
# `ci-both`. A route ahead of the catch-all sends `+15557101` over `ci-pai` and `+15557102` over
# `ci-both`; everything else keeps leaving over `ci-trunk`. The routes in place before are kept
# for the teardown to put back.
set -euo pipefail

api_base=$1
token=$2
compose=$4
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

trunk_ip=$(container_ip sipp)
pai_id=$(api POST /trunks "{
  \"name\": \"ci-pai\",
  \"emergency\": false,
  \"authMode\": \"ip\",
  \"inboundAuth\": true,
  \"username\": \"ci-pai-acct\",
  \"password\": \"ci-pai-secret\",
  \"callerIdHeader\": \"pai\",
  \"hosts\": [{ \"host\": \"$trunk_ip\", \"direction\": \"outbound\" }]
}" | jsonfield trunk.id)
both_id=$(api POST /trunks "{
  \"name\": \"ci-both\",
  \"emergency\": false,
  \"authMode\": \"ip\",
  \"callerIdHeader\": \"both\",
  \"hosts\": [{ \"host\": \"$trunk_ip\", \"direction\": \"outbound\" }]
}" | jsonfield trunk.id)
saved=$(routes_body)
put_routes_ahead "$saved" "+15557101=$pai_id" "+15557102=$both_id"
printf '%s %s\n' "$pai_id" "$both_id" > "$(state_file callerid)"
printf '%s\n' "$saved" > "$(state_file callerid-routes)"

# Both trunks' contacts must exist before the trunk side's qualify waits for them.
await_endpoint "trunk-$pai_id"
await_endpoint "trunk-$both_id"
