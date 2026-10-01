#!/usr/bin/env bash
# §9.4 "Auth mode", "Inbound identification": a `registration` trunk to the second provider,
# whose only host is `outbound` — a registrar, never a source address an `identify` matches — so
# the `line` tag alone can identify its calls. Its calls are addressed to its account name, which
# a DID of that `number` serves, and its caller numbers arrive `national`.
#
# The provider refuses the trunk's first two REGISTERs with 403 (`uas/refuse-register.xml`), and
# only then does its registrar (`uas/registrar.xml`) take the port over: Asterisk "retries every
# `register_retry_s`" (§9.4 "Auth mode"), a 403 included, so the trunk registers on a later
# attempt. The call is placed only once the trunk reports `registered` (§9.4 "Provisioning and
# status") and the registrar holds the tag.
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
  "sh /scenarios/_sipp-run.sh provider-refuse-register \
    -sf /scenarios/uas/refuse-register.xml -p 5060 -m 1 -nostdin asterisk:5060 \
    > /tmp/refuse-register.log 2>&1"

provider_ip=$(container_ip sipp-provider)
trunk_id=$(api POST /trunks "{
  \"name\": \"ci-registration\",
  \"emergency\": false,
  \"authMode\": \"registration\",
  \"username\": \"ci-reg-acct\",
  \"password\": \"ci-reg-secret\",
  \"inboundNumberFormat\": \"national\",
  \"registerExpiryS\": 120,
  \"registerRetryS\": 5,
  \"hosts\": [{ \"host\": \"$provider_ip\", \"direction\": \"outbound\" }]
}" | jsonfield trunk.id)
did_id=$(did_to_group ci-reg-acct "$(ci_group)")
printf '%s %s\n' "$trunk_id" "$did_id" > "$(state_file registration)"

# The refusing run ends once it has answered its REGISTERs; the registrar then takes the port.
await_sipp_run sipp-provider provider-refuse-register $ATTEMPTS || {
  echo "the provider never saw the trunk's first two REGISTERs" >&2
  exit 1
}
# shellcheck disable=SC2086
$compose exec -T -d sipp-provider sh -c \
  'sh /scenarios/_sipp-run.sh provider-registrar \
    -sf /scenarios/uas/registrar.xml -p 5060 -aa -nostdin \
    -trace_msg -message_file /tmp/registrar-messages.log \
    asterisk:5060 > /tmp/registrar.log 2>&1'

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
echo "the registration trunk never registered after its refusals: status $status" >&2
exit 1
