#!/usr/bin/env bash
# Deletes the picking user `inbound-pickup.setup.sh` created, and with them their device. A delete
# asks for confirmation (§10.3), which the REST body gives as `confirm`.
set -euo pipefail

api_base=$1
token=$2

picker_id=$(cat /tmp/zamfono-picker-user)
curl -fsS -X DELETE "$api_base/api/v1/users/$picker_id" \
  -H 'X-Forwarded-For: 127.0.0.1' -H "Authorization: Bearer $token" \
  -H 'Content-Type: application/json' -d '{"confirm":true}' >/dev/null
rm -f /tmp/zamfono-picker-user
