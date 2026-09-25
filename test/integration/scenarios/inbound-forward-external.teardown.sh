#!/usr/bin/env bash
# Clears the forwarding `inbound-forward-external.setup.sh` set.
set -euo pipefail

api_base=$1
token=$2

user_id=$(cat /tmp/zamfono-forward-user)
curl -fsS -X PUT "$api_base/api/v1/users/$user_id/forwarding" \
  -H 'X-Forwarded-For: 127.0.0.1' -H "Authorization: Bearer $token" \
  -H 'Content-Type: application/json' -d '{"rules":[]}' >/dev/null
rm -f /tmp/zamfono-forward-user
