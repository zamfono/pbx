#!/usr/bin/env bash
# The API park and retrieval `inbound-api-park` makes (§10.2 "Call parking"), started in the
# background by its setup before the call arrives: once 101 answered the scenario's call, parks it
# for 101 with `POST /calls/{id}/park`, reads `GET /parking/calls`, and retrieves it on the
# colleague's phone with a click-to-dial to the slot (`POST /calls`), as a CRM's or the MCP
# assistant's buttons would. Leaves `<call-id> <slot> <originated-call-id>` in scenario state
# `api-park` for the check, and the parking list in `api-park-list`.
#
# Usage: _api-park.sh <api-base> <token>
set -uo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

result=$(state_file api-park)
parker_id=$(user_with_ext 101)
retriever_id=$(colleague_id colleague)
if ! call_id=$(await_answered_group_call 30); then
  echo 'no answered call to park' > "$result"
  exit 1
fi
if ! slot=$(api POST "/calls/$call_id/park" "{\"userId\":\"$parker_id\"}" | jsonfield slot); then
  echo "the park of $call_id failed" > "$result"
  exit 1
fi
api GET /parking/calls > "$(state_file api-park-list)"
if ! originated=$(api POST /calls "{\"target\":\"$slot\",\"userId\":\"$retriever_id\"}" \
  | jsonfield callId); then
  echo "the click-to-dial to slot $slot failed" > "$result"
  exit 1
fi
printf '%s %s %s\n' "$call_id" "$slot" "$originated" > "$result"
