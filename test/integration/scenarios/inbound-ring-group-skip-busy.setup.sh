#!/usr/bin/env bash
# §10.1 step 5, "members already in a call are skipped while the group's `skip_busy` is set": a
# ring group whose one member is 101, with `skip_busy` set. As in the offline scenario, its
# `unavailable` rule leads to the group's own mailbox and its `unanswered` rule to an external
# number nothing answers, and a 30 s ring timeout makes any ringing plain in the call's duration.
# 101 stays registered; the phone side puts them on an outbound call before the call arrives.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

member_id=$(user_with_ext 101)
group_id=$(api POST /ringGroups "{
  \"name\": \"ci-busy\",
  \"members\": [{ \"kind\": \"user\", \"id\": \"$member_id\" }],
  \"strategy\": \"simultaneous\",
  \"ringTimeoutS\": 30,
  \"skipBusy\": true,
  \"mailboxEnabled\": true
}" | jsonfield id)
api PUT "/ringGroups/$group_id/forwarding" "{\"rules\": [
  { \"condition\": \"unavailable\", \"target\": { \"kind\": \"mailboxRingGroup\", \"ringGroupId\": \"$group_id\" } },
  { \"condition\": \"unanswered\", \"target\": { \"kind\": \"external\", \"external\": \"+15557777\" } }
]}" >/dev/null
did_id=$(did_to_group +15551004 "$group_id")
printf '%s %s\n' "$group_id" "$did_id" > "$(state_file skip-busy)"
