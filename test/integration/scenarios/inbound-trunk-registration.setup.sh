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
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

ATTEMPTS=45

dc exec -T sipp-provider rm -f /tmp/registrar-line.csv /tmp/registrar-messages.log
# shellcheck disable=SC2086
dc exec -T -d sipp-provider sh -c \
  "sh /scenarios/_sipp-run.sh provider-refuse-register \
    -sf /scenarios/uas/refuse-register.xml -p 5060 -nostdin asterisk:5060 \
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
# A provider's host takes qualify probes too, from whichever `ip` trunk dials it: one arrives while
# the refusals are under way, and the refusing run answers it without losing their place.
asterisk_cli "pjsip qualify trunk-$trunk_id" >/dev/null

# The refusing run ends once it has answered its REGISTERs; the registrar then takes the port.
await_sipp_run sipp-provider provider-refuse-register $ATTEMPTS || {
  echo "the provider never saw the trunk's first two REGISTERs" >&2
  exit 1
}
# Asterisk sends every REGISTER of the registration under one Call-ID, and sipp drops a request on
# the Call-ID of a call it ended within `-deadcall_wait` (33 s by default): with none kept, the
# REGISTERs `trunks.reregister` sends below are each a call of their own.
# shellcheck disable=SC2086
dc exec -T -d sipp-provider sh -c \
  'sh /scenarios/_sipp-run.sh provider-registrar \
    -sf /scenarios/uas/registrar.xml -p 5060 -aa -nostdin -deadcall_wait 0 \
    -trace_msg -message_file /tmp/registrar-messages.log \
    asterisk:5060 > /tmp/registrar.log 2>&1'

# shellcheck disable=SC2086
await_trunk_status "$trunk_id" registered $ATTEMPTS \
  && poll $ATTEMPTS 1 dc exec -T sipp-provider test -s /tmp/registrar-line.csv \
  || { echo "the registration trunk never registered after its refusals" >&2; exit 1; }

# `trunks.reregister` (§9.4 "Provisioning and status"): the trunk unregisters and registers afresh
# with the registrar, and `registeredAt` moves past the moment it was asked, as `statusChangedAt`
# does not for a trunk that stays `registered`.
asked=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
api POST "/trunks/$trunk_id/reregister" '{}' >/dev/null \
  || { echo "trunks.reregister refused the registration trunk" >&2; exit 1; }
poll $ATTEMPTS 1 registered_since "$trunk_id" "$asked" \
  && await_trunk_status "$trunk_id" registered $ATTEMPTS \
  || { echo "the registration trunk never registered afresh after trunks.reregister" >&2; exit 1; }
