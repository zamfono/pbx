#!/usr/bin/env bash
# The live-call actions the `inbound-api-*` scenarios take over the API (§10.3 "Live calls"),
# started in the background by `_api-control-setup.sh` before the call arrives, as a CRM's or the
# MCP assistant's buttons act on the call they show: waits for the scenario's call, then
#
#   consult    consults the colleague at 102 (`POST /calls/{id}/consult`) once the member answered,
#              and transfers the call to that consultation (`POST /calls/{id}/transfer` with
#              `toCallId`) once the colleague answered it;
#   add-party  adds the colleague at 102 (`POST /calls/{id}/parties`) once the member answered,
#              and counts the bridge's channels once the colleague answered too;
#   hold       holds the call (`POST /calls/{id}/hold`) once the member answered and resumes it
#              (`/resume`), counting the bridge's channels after each;
#   decline    declines the call (`POST /calls/{id}/decline`) as the token's own user, `$5`, once
#              it rings them;
#   park       parks the caller's leg (`POST /calls/{id}/park`) once 101 answered, 101 its
#              parker, lists the parked calls (`GET /parking/calls`, scenario state
#              `api-control.parked`) and retrieves it on the colleague's phone with a
#              click-to-dial to the slot (`POST /calls`);
#   deposit    transfers the call into 101's own mailbox (`POST /calls/{id}/transfer` with
#              `voicemail`) once 101 answered;
#   pickup     the colleague picks the call up (`POST /calls/{id}/pickup`) with their own token,
#              `$5`, while it rings the group's member;
#   leg-transfer
#              `$5` is `<to>,<role>,<target>`: once the call to `<to>` is bridged, its legs all
#              up, lists them (scenario state `api-control.legs`) and transfers its first leg of
#              `<role>` to `<target>` (`POST /calls/{id}/transfer` with `legId`).
#
# The live listing reports a call `up` once it is answered and bridged, so each action is asked
# for once, as soon as the call is in the state it needs, and its status is recorded as it came.
# The token is an admin's, who is in none of these calls, so every action that moves, holds or
# parks a party names it: the caller's leg (`legId`, §10.3 "Live calls").
# Leaves one line in scenario state `api-control` for the check (`_api-control-check.sh`): the
# HTTP statuses, then the call ids and the counts, `none` when the call never came; its log is
# scenario state `api-control.log`.
#
# Usage: _api-control.sh <api-base> <token> <compose> <mode> [<arg>]
set -uo pipefail

api_base=$1
token=$2
compose=$3
mode=$4
arg=${5:-}
# shellcheck source=_colleague.sh
. "$(dirname "$0")/_colleague.sh"

result=$(state_file api-control)

# The most channels any bridge in Asterisk holds right now: the scenario's call is the only one.
# A bridge's line starts with its id and gives its channel count as the first plain number after
# it, whether or not a name column comes between; the listing goes to the log as it was.
bridge_channels() {
  local listing
  listing=$(asterisk_cli 'bridge show all' 2>&1 | tr -d '\r')
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

# Whether the live call to `$1` is bridged, two legs or more and all of them up: the call's id
# and that of its first leg of role `$2` are left in `call_id` and `leg`, the call's legs in
# scenario state `api-control.legs`.
bridged_leg() {
  local found
  found=$(api GET '/calls?live=true' | python3 -c '
import json, sys
to, role, legs_file = sys.argv[1:4]
for call in json.load(sys.stdin)["items"]:
    leg = next((leg for leg in call["legs"] if leg["role"] == role), None)
    bridged = len(call["legs"]) > 1 and all(l["state"] == "up" for l in call["legs"])
    if call["to"] == to and leg is not None and bridged:
        with open(legs_file, "w") as out:
            json.dump(call["legs"], out)
        print(call["callId"], leg["id"])
        break
' "$1" "$2" "$(state_file api-control.legs)") && [ -n "$found" ] && read -r call_id leg <<<"$found"
}

# POSTs `$2` to `/calls$1`, logging the answer, and prints its status, then its body on a line of
# its own.
post() {
  local data='{}' answer
  [ $# -lt 2 ] || data=$2
  answer=$(api_status POST "/calls$1" "$data") || answer=$'none\n'
  printf 'POST /calls%s: %s\n' "$1" "${answer//$'\n'/ }" >&2
  printf '%s\n' "$answer"
}

case $mode in
  consult)
    call_id=$(await_live_call up) || { echo none > "$result"; exit 1; }
    leg=$(live_leg "$call_id" caller) || { echo none > "$result"; exit 1; }
    { read -r code; read -r body; } < <(post "/$call_id/consult" \
      "{\"target\":\"102\",\"legId\":\"$leg\"}")
    if ! consultation=$(printf '%s' "$body" | jsonfield callId) \
      || ! await_live_call up "$consultation" >/dev/null; then
      echo "$code none" > "$result"
      exit 1
    fi
    { read -r transferred; read -r _; } < <(post "/$call_id/transfer" \
      "{\"toCallId\":\"$consultation\",\"legId\":\"$leg\"}")
    printf '%s %s %s %s\n' "$code" "$transferred" "$call_id" "$consultation" > "$result"
    ;;
  add-party)
    call_id=$(await_live_call up) || { echo none > "$result"; exit 1; }
    { read -r code; read -r body; } < <(post "/$call_id/parties" '{"target":"102"}')
    if ! added=$(printf '%s' "$body" | jsonfield callId) \
      || ! await_live_call up "$added" >/dev/null; then
      echo "$code none" > "$result"
      exit 1
    fi
    printf '%s %s %s %s\n' "$code" "$call_id" "$added" "$(bridge_channels)" > "$result"
    ;;
  hold)
    call_id=$(await_live_call up) || { echo none > "$result"; exit 1; }
    leg=$(live_leg "$call_id" caller) || { echo none > "$result"; exit 1; }
    { read -r held; read -r _; } < <(post "/$call_id/hold" "{\"legId\":\"$leg\"}")
    while_held=$(bridge_channels)
    { read -r resumed; read -r _; } < <(post "/$call_id/resume")
    printf '%s %s %s %s %s\n' "$held" "$resumed" "$call_id" "$while_held" \
      "$(bridge_channels)" > "$result"
    ;;
  decline)
    call_id=$(await_live_call ringing '' "$arg") || { echo none > "$result"; exit 1; }
    { read -r code; read -r _; } < <(post "/$call_id/decline")
    printf '%s %s\n' "$code" "$call_id" > "$result"
    ;;
  park)
    call_id=$(await_live_call up) || { echo none > "$result"; exit 1; }
    leg=$(live_leg "$call_id" caller) || { echo none > "$result"; exit 1; }
    { read -r parked; read -r body; } < <(post "/$call_id/park" "{\"legId\":\"$leg\"}")
    slot=$(printf '%s' "$body" | jsonfield slot)
    api GET /parking/calls > "$(state_file api-control.parked)"
    { read -r originated; read -r body; } < <(post '' \
      "{\"target\":\"$slot\",\"userId\":\"$(colleague_id colleague)\"}")
    printf '%s %s %s %s %s\n' "$parked" "$originated" "$call_id" "$slot" \
      "$(printf '%s' "$body" | jsonfield callId)" > "$result"
    ;;
  deposit)
    call_id=$(await_live_call up) || { echo none > "$result"; exit 1; }
    leg=$(live_leg "$call_id" caller) || { echo none > "$result"; exit 1; }
    { read -r code; read -r _; } < <(post "/$call_id/transfer" \
      "{\"target\":\"101\",\"voicemail\":true,\"legId\":\"$leg\"}")
    printf '%s %s\n' "$code" "$call_id" > "$result"
    ;;
  pickup)
    call_id=$(await_live_call ringing) || { echo none > "$result"; exit 1; }
    { read -r code; read -r _; } < <(token=$arg post "/$call_id/pickup")
    printf '%s %s\n' "$code" "$call_id" > "$result"
    ;;
  leg-transfer)
    IFS=, read -r to role target <<<"$arg"
    poll 150 0.2 bridged_leg "$to" "$role" || { echo none > "$result"; exit 1; }
    { read -r code; read -r _; } < <(post "/$call_id/transfer" \
      "{\"target\":\"$target\",\"legId\":\"$leg\"}")
    printf '%s %s %s\n' "$code" "$call_id" "$leg" > "$result"
    ;;
esac
