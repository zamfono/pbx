#!/usr/bin/env bash
# §10.2 "Effective flag": 181 records no calls, so the answered trunk leg of their unconditional
# forward to a SIP target leaves no recording: no `recordings` row for the call, and no raw pair
# in `media/recordings` that a later mix would store as one.
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

call_id=$(await_new_call "$(cat "$(state_file recording-before)")" 15)
status=$(api GET "/calls/$call_id" | jsonfield status)
[ "$status" = answered ] || {
  echo "call $call_id ended $status, not answered over the trunk" >&2
  exit 1
}
rows=$(api GET /recordings | python3 -c '
import json, sys
print(sum(1 for r in json.load(sys.stdin)["items"] if r["callId"] == sys.argv[1]))
' "$call_id")
[ "$rows" -eq 0 ] || {
  echo "call $call_id left $rows recordings rows though 181 records no calls" >&2
  exit 1
}
files=$(dc exec -T core ls /media/recordings)
if printf '%s\n' "$files" | grep -q -- '-[lr]\.'; then
  echo "call $call_id left raw recording files though 181 records no calls: $files" >&2
  exit 1
fi
