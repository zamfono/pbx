#!/usr/bin/env bash
# §8 "OOO": an out-of-office rule on the ring group, sending the call to the group's mailbox
# instead of ringing anyone. Records the rule's id for the teardown.
set -euo pipefail

api_base=$1
token=$2

api() {
  curl -fsS -X "$1" "$api_base/api/v1$2" -H 'X-Forwarded-For: 127.0.0.1' \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "$3"
}

group_id=$(curl -fsS "$api_base/api/v1/ringGroups" -H 'X-Forwarded-For: 127.0.0.1' \
  -H "Authorization: Bearer $token" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['items'][0]['id'])")

rule_id=$(api POST "/ringGroups/$group_id/ooo" "{
  \"active\": true,
  \"target\": { \"kind\": \"mailboxRingGroup\", \"ringGroupId\": \"$group_id\" }
}" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

printf '%s\n' "$rule_id" > /tmp/zamfono-ooo-rule
