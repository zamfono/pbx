#!/usr/bin/env bash
# §9.4 "Route fallthrough": two routes ahead of the catch-all carry `+15557201`, the first over
# `ci-trunk`, whose trunk side refuses it with 403 (`uas/refuse-403.xml`), the second over a trunk
# to the second provider, which answers 100 and 183 at once and 200 only after 10 seconds
# (`uas/answer-progress.xml`). The provider's side runs first, so the trunk's qualify finds it
# reachable; the routes in place before are kept for the teardown to put back.
set -euo pipefail

api_base=$1
token=$2
compose=$4
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

# shellcheck disable=SC2086 # `$compose` carries the runtime's own multi-word command
$compose exec -T -d sipp-provider sh -c \
  'sh /scenarios/_sipp-run.sh provider-answer-progress \
    -sf /scenarios/uas/answer-progress.xml -p 5060 -aa -nostdin asterisk:5060 \
    > /tmp/answer-progress.log 2>&1'

provider_ip=$(container_ip sipp-provider)
second_id=$(api POST /trunks "{
  \"name\": \"ci-second\",
  \"emergency\": false,
  \"authMode\": \"ip\",
  \"hosts\": [{ \"host\": \"$provider_ip\", \"direction\": \"outbound\" }]
}" | jsonfield trunk.id)
saved=$(routes_body)
put_routes_ahead "$saved" "+15557201=$(trunk_named ci-trunk)" "+15557201=$second_id"
printf '%s\n' "$second_id" > "$(state_file fallthrough)"
printf '%s\n' "$saved" > "$(state_file fallthrough-routes)"

await_endpoint "trunk-$second_id"
