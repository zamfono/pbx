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
#   park       parks the call for 101 (`POST /calls/{id}/park`) once 101 answered, lists the
#              parked calls (`GET /parking/calls`, scenario state `api-control.parked`) and
#              retrieves it on the colleague's phone with a click-to-dial to the slot (`POST
#              /calls`);
#   deposit    transfers the call into 101's own mailbox (`POST /calls/{id}/transfer` with
#              `voicemail`) once 101 answered;
#   pickup     picks the call up for the colleague (`POST /calls/{id}/pickup`) while it rings the
#              group's member.
#
# The live listing reports a call `up` once it is answered and bridged, so each action is asked
# for once, as soon as the call is in the state it needs, and its status is recorded as it came.
# Leaves one line in scenario state `api-control` for the check (`_api-control-check.sh`): the
# HTTP statuses, then the call ids and the counts, `none` when the call never came; its log is
# scenario state `api-control.log`.
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

# The most channels any bridge in Asterisk holds right now: the scenario's call is the only one.
# A bridge's line starts with its id and gives its channel count as the first plain number after
# it, whether or not a name column comes between; the listing goes to the log as it was.
bridge_channels() {
  local listing
  listing=$(dc exec -T asterisk asterisk -rx 'bridge show all' 2>&1 | tr -d '\r')
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
    { read -r code; read -r body; } < <(post "/$call_id/consult" '{"target":"102"}')
    if ! consultation=$(printf '%s' "$body" | jsonfield callId) \
      || ! await_live_call up "$consultation" >/dev/null; then
      echo "$code none" > "$result"
      exit 1
    fi
    { read -r transferred; read -r _; } < <(post "/$call_id/transfer" \
      "{\"toCallId\":\"$consultation\"}")
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
    { read -r held; read -r _; } < <(post "/$call_id/hold")
    while_held=$(bridge_channels)
    { read -r resumed; read -r _; } < <(post "/$call_id/resume")
    printf '%s %s %s %s %s\n' "$held" "$resumed" "$call_id" "$while_held" \
      "$(bridge_channels)" > "$result"
    ;;
  decline)
    call_id=$(await_live_call ringing '' "$user_id") || { echo none > "$result"; exit 1; }
    { read -r code; read -r _; } < <(post "/$call_id/decline")
    printf '%s %s\n' "$code" "$call_id" > "$result"
    ;;
  park)
    call_id=$(await_live_call up) || { echo none > "$result"; exit 1; }
    { read -r parked; read -r body; } < <(post "/$call_id/park" \
      "{\"userId\":\"$(user_with_ext 101)\"}")
    slot=$(printf '%s' "$body" | jsonfield slot)
    api GET /parking/calls > "$(state_file api-control.parked)"
    { read -r originated; read -r body; } < <(post '' \
      "{\"target\":\"$slot\",\"userId\":\"$(colleague_id colleague)\"}")
    printf '%s %s %s %s %s\n' "$parked" "$originated" "$call_id" "$slot" \
      "$(printf '%s' "$body" | jsonfield callId)" > "$result"
    ;;
  deposit)
    call_id=$(await_live_call up) || { echo none > "$result"; exit 1; }
    { read -r code; read -r _; } < <(post "/$call_id/transfer" '{"target":"101","voicemail":true}')
    printf '%s %s\n' "$code" "$call_id" > "$result"
    ;;
  pickup)
    call_id=$(await_live_call ringing) || { echo none > "$result"; exit 1; }
    { read -r code; read -r _; } < <(post "/$call_id/pickup" \
      "{\"userId\":\"$(colleague_id colleague)\"}")
    printf '%s %s\n' "$code" "$call_id" > "$result"
    ;;
esac
