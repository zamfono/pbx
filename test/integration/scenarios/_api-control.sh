#!/usr/bin/env bash
# The call control the `inbound-api-*` scenarios make over the API (§10.3 "Live calls"), started
# in the background by their setup before the call arrives, as a CRM's or the MCP assistant's
# buttons would act on it: waits for the scenario's call, then
#
#   consult    consults the colleague at 102 (`POST /calls/{id}/consult`) once the member answered,
#              and transfers the call to that consultation (`POST /calls/{id}/transfer` with
#              `toCallId`) once the colleague answered it;
#   add-party  adds the colleague at 102 (`POST /calls/{id}/parties`) once the member answered,
#              and counts the bridge's channels once the colleague answered too;
#   hold       holds the call (`POST /calls/{id}/hold`) once the member answered and resumes it
#              (`/resume`) two seconds later, counting the bridge's channels in each state;
#   decline    declines the call (`POST /calls/{id}/decline`) as the token's own user, `$4`, once
#              it rings them.
#
# A 409 while the call is not yet where the action needs it is retried. Leaves the HTTP statuses,
# the call ids and the counts in scenario state `api-control`, one line, `none` when the call never
# came, for the check; its log is scenario state `api-control.log`.
#
# Usage: _api-control.sh <api-base> <token> <compose> <mode> [<user-id>]
set -uo pipefail

api_base=$1
token=$2
compose=$3
mode=$4
user_id=${5:-}
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

result=$(state_file api-control)
ATTEMPTS=150

# The id of the live call in `$1` (`up` or `ringing`) that reached the group, or that is `$2`
# itself; with `$3`, only one that user's phone rings or is in. Empty while there is none.
live_call() {
  api GET '/calls?live=true' 2>/dev/null | python3 -c '
import json, sys
state, wanted, user = sys.argv[1:4]
for call in json.load(sys.stdin)["items"]:
    if call["state"] != state:
        continue
    if wanted and call["callId"] != wanted:
        continue
    if not wanted and not call["ringGroupId"]:
        continue
    if user and user not in call["userIds"]:
        continue
    print(call["callId"])
    break
' "$1" "${2:-}" "${3:-}" 2>/dev/null
}

# Waits for `live_call "$@"` to name a call, and prints it.
await_live() {
  local id
  for _ in $(seq 1 $ATTEMPTS); do
    id=$(live_call "$@")
    if [ -n "$id" ]; then
      printf '%s\n' "$id"
      return 0
    fi
    sleep 0.2
  done
  return 1
}

# POSTs `$2` to `/calls/$1`, retrying while the stack answers 409, and prints the status, then
# the response body on a line of its own.
post() {
  local code body data='{}'
  [ $# -lt 2 ] || data=$2
  body=$(mktemp)
  for _ in $(seq 1 $ATTEMPTS); do
    code=$(curl -sS -o "$body" -w '%{http_code}' -X POST "$api_base/api/v1/calls/$1" \
      -H 'X-Forwarded-For: 127.0.0.1' -H "Authorization: Bearer $token" \
      -H 'Content-Type: application/json' -d "$data")
    [ "$code" = 409 ] || break
    sleep 0.2
  done
  printf '%s\n%s\n' "$code" "$(cat "$body")"
  rm -f "$body"
}

# The most channels any bridge in Asterisk holds right now: the scenario's call is the only one.
# A bridge's line starts with its id and gives its channel count as the first plain number after
# it, whether or not a name column comes between; the listing goes to the log as it was.
bridge_channels() {
  local listing
  # shellcheck disable=SC2086 -- `$compose` carries the runtime's own multi-word command
  listing=$($compose exec -T asterisk asterisk -rx 'bridge show all' 2>&1 | tr -d '\r')
  printf '%s\n' "$listing" >&2
  printf '%s\n' "$listing" | awk '
    $1 ~ /^[0-9a-f-]+$/ && length($1) == 36 {
      for (i = 2; i <= NF; i++) {
        if ($i ~ /^[0-9]+$/) {
          if ($i + 0 > max) { max = $i + 0 }
          break
        }
      }
    }
    END { print max + 0 }'
}

field() {
  python3 -c 'import json, sys; print(json.load(sys.stdin).get(sys.argv[1], ""))' "$1"
}

case $mode in
  consult)
    call_id=$(await_live up) || { echo none > "$result"; exit 1; }
    { read -r code; read -r body; } < <(post "$call_id/consult" '{"target":"102"}')
    consultation=$(printf '%s' "$body" | field callId)
    await_live up "$consultation" >/dev/null || { echo "$code none" > "$result"; exit 1; }
    { read -r transferred; read -r _; } < <(post "$call_id/transfer" \
      "{\"toCallId\":\"$consultation\"}")
    printf '%s %s %s %s\n' "$code" "$transferred" "$call_id" "$consultation" > "$result"
    ;;
  add-party)
    call_id=$(await_live up) || { echo none > "$result"; exit 1; }
    { read -r code; read -r body; } < <(post "$call_id/parties" '{"target":"102"}')
    added=$(printf '%s' "$body" | field callId)
    await_live up "$added" >/dev/null || { echo "$code none" > "$result"; exit 1; }
    sleep 1
    printf '%s %s %s %s\n' "$code" "$call_id" "$added" "$(bridge_channels)" > "$result"
    ;;
  hold)
    call_id=$(await_live up) || { echo none > "$result"; exit 1; }
    { read -r held; read -r _; } < <(post "$call_id/hold")
    sleep 2
    while_held=$(bridge_channels)
    { read -r resumed; read -r _; } < <(post "$call_id/resume")
    sleep 1
    printf '%s %s %s %s %s\n' "$held" "$resumed" "$call_id" "$while_held" \
      "$(bridge_channels)" > "$result"
    ;;
  decline)
    call_id=$(await_live ringing '' "$user_id") || { echo none > "$result"; exit 1; }
    { read -r code; read -r _; } < <(post "$call_id/decline")
    printf '%s %s\n' "$code" "$call_id" > "$result"
    ;;
esac
