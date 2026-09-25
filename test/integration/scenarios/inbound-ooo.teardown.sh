#!/usr/bin/env bash
# Removes the rule `inbound-ooo.setup.sh` created, so the scenarios after it ring as usual.
set -euo pipefail

api_base=$1
token=$2

rule_id=$(cat /tmp/zamfono-ooo-rule)
curl -fsS -X DELETE "$api_base/api/v1/ooo/$rule_id" -H 'X-Forwarded-For: 127.0.0.1' \
  -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d '{"confirm":true}' >/dev/null
rm -f /tmp/zamfono-ooo-rule
