#!/usr/bin/env bash
# §9.4 "Inbound identification", "Inbound number normalization": a `registration` trunk whose
# provider addresses the INVITE to the contact the trunk registered, so its Request-URI user is the
# account name, and carries the dialled number in `To` alone — mucpbx does, and its calls failed
# with 404 until the boundary read `To`. No DID bears the account name here, so only the number in
# `To` can route the call. The trunk registers at once (inbound-trunk-registration covers the
# refused REGISTERs); the call is placed once it reports `registered` and the registrar holds the
# `line` tag.
set -euo pipefail

api_base=$1
token=$2
compose=$4
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

ATTEMPTS=45

# shellcheck disable=SC2086 # `$compose` carries the runtime's own multi-word command
$compose exec -T sipp-provider rm -f /tmp/registrar-line.csv /tmp/registrar-messages.log
# shellcheck disable=SC2086
$compose exec -T -d sipp-provider sh -c \
  'sh /scenarios/_sipp-run.sh provider-registrar \
    -sf /scenarios/uas/registrar.xml -p 5060 -aa -nostdin \
    -trace_msg -message_file /tmp/registrar-messages.log \
    asterisk:5060 > /tmp/registrar.log 2>&1'

provider_ip=$(container_ip sipp-provider)
trunk_id=$(api POST /trunks "{
  \"name\": \"ci-registration-to\",
  \"emergency\": false,
  \"authMode\": \"registration\",
  \"username\": \"ci-reg-to\",
  \"password\": \"ci-reg-secret\",
  \"inboundNumberFormat\": \"national\",
  \"registerExpiryS\": 120,
  \"registerRetryS\": 5,
  \"hosts\": [{ \"host\": \"$provider_ip\", \"direction\": \"outbound\" }]
}" | jsonfield trunk.id)
did_id=$(did_to_group +15551077 "$(ci_group)")
printf '%s %s\n' "$trunk_id" "$did_id" > "$(state_file registration-to)"

status=unknown
for _ in $(seq 1 $ATTEMPTS); do
  status=$(api GET "/trunks/$trunk_id" | jsonfield status)
  # shellcheck disable=SC2086
  if [ "$status" = registered ] \
    && $compose exec -T sipp-provider test -s /tmp/registrar-line.csv; then
    exit 0
  fi
  sleep 1
done
echo "the registration trunk never registered: status $status" >&2
exit 1
