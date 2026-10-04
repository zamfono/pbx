#!/usr/bin/env bash
# Shared setup of the `inbound-api-pickup*` scenarios (§10.1 "Pickup" over the API): the ring
# group's timeout lengthened to 10 s so the pickup settles well within it (the one in place
# before is kept for `_api-pickup-teardown.sh`), and the pickup by a colleague, 102, whose phone
# is served by phone scenario `$4` (`_api-control-setup.sh pickup`). A pickup takes the call onto
# the caller's own phones (§10.3 "Live calls"), so the colleague sets a password through the link
# `POST /users/{id}/resetPassword` returns, as a new employee does (§5.2), and picks up with a
# token of their own. `$5`, if given, is the colleague's own ring timeout (§11.2
# `users.ring_timeout_s`), the ring the pickup starts on their phone.
#
# Usage: _api-pickup-setup.sh <api-base> <token> <compose> <colleague-uas> [<ring-timeout-s>]
set -euo pipefail

api_base=$1
token=$2
compose=$3
uas=$4
ring_timeout_s=${5:-}
here=$(dirname "$0")
# shellcheck source=_colleague.sh
. "$here/_colleague.sh"

PICKER_EMAIL=api-control@ci.test
PICKER_PASSWORD=picker-secret

group_id=$(ci_group)
api GET "/ringGroups/$group_id" | jsonfield ringTimeoutS > "$(state_file api-pickup-group)"
api PATCH "/ringGroups/$group_id" '{"ringTimeoutS": 10}' >/dev/null
add_colleague 'CI Colleague' "$PICKER_EMAIL" 102 colleague
picker_id=$(colleague_id colleague)
if [ -n "$ring_timeout_s" ]; then
  api PATCH "/users/$picker_id" "{\"ringTimeoutS\": $ring_timeout_s}" >/dev/null
fi
link=$(api POST "/users/$picker_id/resetPassword" '{}' | jsonfield link)
curl -fsS -X POST "$api_base/auth/reset" "${FWD[@]}" -H 'Content-Type: application/json' \
  -d "{\"token\":\"${link##*token=}\",\"password\":\"$PICKER_PASSWORD\"}" >/dev/null
picker_token=$(bash "$here/../bootstrap-token.sh" "$api_base" "$PICKER_EMAIL" \
  "$PICKER_PASSWORD" "${link%%/auth/*}")
serve_colleague "$uas" colleague
bash "$here/_api-control-setup.sh" "$api_base" "$token" "$compose" pickup '' "$picker_token"
