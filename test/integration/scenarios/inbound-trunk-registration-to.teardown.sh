#!/usr/bin/env bash
# Removes the trunk and DID `inbound-trunk-registration-to.setup.sh` created. Deleting the trunk
# makes Asterisk de-register it, a REGISTER with `Expires: 0` to the provider, whose registrar
# already ended with the scenario (`run-scenarios.sh`'s `finish_sipp_runs`); unanswered, Asterisk
# retransmits it into the next scenario on the provider's port, where inbound-trunk-registration's
# refusing run would count it as the trunk's first REGISTER. So a registrar answers it here.
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

ATTEMPTS=15
TRACE=/tmp/unregister-messages.log

# shellcheck disable=SC2086 # `$compose` carries the runtime's own multi-word command
$compose exec -T sipp-provider rm -f "$TRACE"
# shellcheck disable=SC2086
$compose exec -T -d sipp-provider sh -c \
  "sh /scenarios/_sipp-run.sh provider-unregister \
    -sf /scenarios/uas/registrar.xml -p 5060 -m 1 -nostdin -trace_msg -message_file $TRACE \
    asterisk:5060 > /tmp/unregister.log 2>&1"

read -r trunk_id did_id < "$(state_file registration-to)"
api_delete "/dids/$did_id"
api_delete "/trunks/$trunk_id"
rm -f "$(state_file registration-to)"

# `-m 1`: the run answers that one REGISTER and ends by itself, so nothing is left on the port.
# shellcheck disable=SC2086
if ! await_sipp_run sipp-provider provider-unregister $ATTEMPTS \
  || ! $compose exec -T sipp-provider grep -qiE '^Expires: *0' "$TRACE"; then
  # shellcheck disable=SC2086
  $compose exec -T sipp-provider sh /scenarios/_sipp-finish.sh 5 >/dev/null 2>&1 || true
  echo "the deleted trunk's de-registration never reached the provider" >&2
  exit 1
fi
