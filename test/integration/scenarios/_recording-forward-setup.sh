#!/usr/bin/env bash
# The setup the forward recording scenarios share (§10.2 "Effective flag"): DID +15551011 reaches
# user 181, whose `record_calls` is `$4` and whose unconditional rule forwards to target kind `$5`,
# `sip` (`proj_rec` over the CI trunk) or `external` (+15557777, out through the CI route), so the
# call leaves again over the trunk, where the scenario's `TRUNK_UAS` answers it. Leaves the ids
# the teardown removes, and the newest call before the scenario's own for the check.
#
# Usage: _recording-forward-setup.sh <api-base> <token> <compose> <true|false> <sip|external>
set -euo pipefail

api_base=$1
token=$2
record=$4
kind=$5
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

user_id=$(api POST /users '{"name":"CI Recorded","email":"recorded@ci.test","extension":"181"}' \
  | jsonfield user.id)
api PATCH "/users/$user_id" "{\"recordCalls\": $record}" >/dev/null
did_id=$(api POST /dids \
  "{\"number\":\"+15551011\",\"target\":{\"kind\":\"user\",\"userId\":\"$user_id\"}}" \
  | jsonfield id)
if [ "$kind" = sip ]; then
  target="{\"kind\":\"sip\",\"trunkId\":\"$(trunk_named ci-trunk)\",\"user\":\"proj_rec\"}"
else
  target='{"kind":"external","external":"+15557777"}'
fi
api PUT "/users/$user_id/forwarding" \
  "{\"rules\":[{\"condition\":\"unconditional\",\"target\":$target}]}" >/dev/null
printf '%s %s\n' "$user_id" "$did_id" > "$(state_file recording-forward)"
newest_call_id > "$(state_file recording-before)"
