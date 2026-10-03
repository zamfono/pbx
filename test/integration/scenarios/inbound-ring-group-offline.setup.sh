#!/usr/bin/env bash
# §10.1 step 5, "If no member is ringable, the `unavailable` rule fires immediately without
# ringing": a ring group of two offline members, 101, whose device no run registers for this
# scenario (`run-scenarios.sh`'s `listen`), and a new user 103, whose device never registered. Its `unavailable` rule leads to the group's own
# mailbox, and its `unanswered` rule elsewhere, to an external number nothing answers, so which
# rule fired shows in the history. A 30 s ring timeout makes any ringing plain in the call's
# duration. The call is placed once the core reports 101 offline (§10.2 "Presence and BLF").
set -euo pipefail

api_base=$1
token=$2
compose=$3
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

ATTEMPTS=20

member_id=$(user_with_ext 101)
allowed=$(api GET "/users/$member_id/devices" | python3 -c "
import json, sys
print(json.dumps(json.load(sys.stdin)['items'][0]['allowedIps']))
")

absent_id=$(api POST /users '{"name":"CI Absent","email":"absent@ci.test","extension":"103"}' \
  | jsonfield user.id)
api POST "/users/$absent_id/devices" \
  "{\"kind\":\"manual\",\"label\":\"ci-absent\",\"transport\":\"plain\",\"allowedIps\":$allowed}" \
  >/dev/null

group_id=$(api POST /ringGroups "{
  \"name\": \"ci-offline\",
  \"members\": [{ \"kind\": \"user\", \"id\": \"$member_id\" }, { \"kind\": \"user\", \"id\": \"$absent_id\" }],
  \"strategy\": \"simultaneous\",
  \"ringTimeoutS\": 30,
  \"mailboxEnabled\": true
}" | jsonfield id)
api PUT "/ringGroups/$group_id/forwarding" "{\"rules\": [
  { \"condition\": \"unavailable\", \"target\": { \"kind\": \"mailboxRingGroup\", \"ringGroupId\": \"$group_id\" } },
  { \"condition\": \"unanswered\", \"target\": { \"kind\": \"external\", \"external\": \"+15557777\" } }
]}" >/dev/null
did_id=$(did_to_group +15551003 "$group_id")
printf '%s %s %s %s\n' "$member_id" "$absent_id" "$group_id" "$did_id" \
  > "$(state_file offline)"

status=unknown
for _ in $(seq 1 $ATTEMPTS); do
  status=$(api GET "/presence/log?at=9999-12-31T00:00:00.000Z&userId=$member_id" \
    | jsonfield items.0.status)
  if [ "$status" = offline ]; then
    exit 0
  fi
  sleep 1
done
echo "101 never read offline: $status" >&2
exit 1
