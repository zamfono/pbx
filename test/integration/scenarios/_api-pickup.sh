#!/usr/bin/env bash
# The API pickup the `inbound-api-pickup*` scenarios make (§10.1 "Pickup", `POST
# /calls/{id}/pickup`), started in the background by their setup before the call arrives: waits
# for the scenario's call to ring the group's member, then asks for the colleague of scenario
# state `colleague` to pick it up, as a CRM's or the MCP assistant's pickup button does. A 409
# while the ring is still being placed (`notRinging`) is retried. Leaves `<http-status> <call-id>`
# in scenario state `api-pickup` for the check.
#
# Usage: _api-pickup.sh <api-base> <token>
set -uo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

result=$(state_file api-pickup)
picker_id=$(colleague_id colleague)
for _ in $(seq 1 150); do
  call_id=$(api GET '/calls?live=true' 2>/dev/null | python3 -c '
import json, sys
calls = json.load(sys.stdin)["items"]
print(next((c["callId"] for c in calls if c["state"] == "ringing" and c["ringGroupId"]), ""))
' 2>/dev/null)
  if [ -n "$call_id" ]; then
    code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
      "$api_base/api/v1/calls/$call_id/pickup" -H 'X-Forwarded-For: 127.0.0.1' \
      -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
      -d "{\"userId\":\"$picker_id\"}")
    if [ "$code" != 409 ]; then
      printf '%s %s\n' "$code" "$call_id" > "$result"
      exit 0
    fi
  fi
  sleep 0.2
done
echo "none" > "$result"
exit 1
