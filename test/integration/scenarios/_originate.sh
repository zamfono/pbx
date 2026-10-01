#!/usr/bin/env bash
# The caller of the click-to-dial scenarios (§10.2 "Click-to-dial"), played in place of a sipp run
# (`run-scenarios.sh` runs a scenario's `<name>.call.sh` where it has one): `POST /calls` to `$3`
# on behalf of user 101, as a CRM's call button places it, then waits for the call to end,
# however it ends. The call's id is left in scenario state `originated` for the check; the actor
# is the harness's own owner, whose id the check reads from the trace.
#
# Usage: _originate.sh <api-base> <token> <target> [<seconds> [<more-fields>]]
#   <more-fields>: further members of the request body, as JSON, such as `"clir": true`.
set -euo pipefail

api_base=$1
token=$2
target=$3
seconds=${4:-60}
more=${5:+,$5}
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

user_id=$(user_with_ext 101)
call_id=$(api POST /calls "{\"target\":\"$target\",\"userId\":\"$user_id\"$more}" \
  | jsonfield callId)
printf '%s\n' "$call_id" > "$(state_file originated)"
await_ended_call "$call_id" "$seconds" >/dev/null
