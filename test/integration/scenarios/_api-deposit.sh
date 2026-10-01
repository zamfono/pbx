#!/usr/bin/env bash
# The API transfer to voicemail `inbound-api-deposit` makes (§9.3 `*97<ext>`, §10.1 "Transfers
# and pickup"), started in the background by its setup before the call arrives: once 101 answered
# the scenario's call, transfers it into 101's own mailbox with `POST /calls/{id}/transfer` and
# `voicemail: true`, as "put them through to her voicemail" from a CRM would. Leaves
# `<http-status> <call-id>` in scenario state `api-deposit` for the check.
#
# Usage: _api-deposit.sh <api-base> <token>
set -uo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

result=$(state_file api-deposit)
if ! call_id=$(await_answered_group_call 30); then
  echo 'none' > "$result"
  exit 1
fi
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  "$api_base/api/v1/calls/$call_id/transfer" -H 'X-Forwarded-For: 127.0.0.1' \
  -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d '{"target":"101","voicemail":true}')
printf '%s %s\n' "$code" "$call_id" > "$result"
