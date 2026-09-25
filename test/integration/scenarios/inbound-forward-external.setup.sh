#!/usr/bin/env bash
# §8 "forwarding chains": the ring group's only member forwards unconditionally to an external
# number, so the call leaves again over the trunk instead of ringing the member's device.
set -euo pipefail

api_base=$1
token=$2

api() {
  curl -fsS -X "$1" "$api_base/api/v1$2" -H 'X-Forwarded-For: 127.0.0.1' \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "$3"
}

user_id=$(curl -fsS "$api_base/api/v1/users" -H 'X-Forwarded-For: 127.0.0.1' \
  -H "Authorization: Bearer $token" \
  | python3 -c "
import json, sys
print([u['id'] for u in json.load(sys.stdin)['items'] if u['extension'] == '101'][0])
")

api PUT "/users/$user_id/forwarding" \
  '{"rules":[{"condition":"unconditional","target":{"kind":"external","external":"+15557777"}}]}' \
  >/dev/null
printf '%s\n' "$user_id" > /tmp/zamfono-forward-user
