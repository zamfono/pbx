#!/usr/bin/env bash
# Shared setup of the `inbound-api-pickup*` scenarios (§10.1 "Pickup" over the API): the ring
# group's timeout lengthened to 10 s so the pickup settles well within it (the one in place
# before is kept for `_api-pickup-teardown.sh`), and the pickup by a colleague, 102, whose phone
# is served by phone scenario `$4` (`_api-control-setup.sh pickup`). `$5`, if given, is the
# colleague's own ring timeout (§11.2 `users.ring_timeout_s`), the ring the pickup starts on their
# phone.
#
# Usage: _api-pickup-setup.sh <api-base> <token> <compose> <colleague-uas> [<ring-timeout-s>]
set -euo pipefail

api_base=$1
token=$2
compose=$3
uas=$4
ring_timeout_s=${5:-}
here=$(dirname "$0")
# shellcheck source=_lib.sh
. "$here/_lib.sh"

group_id=$(ci_group)
api GET "/ringGroups/$group_id" | jsonfield ringTimeoutS > "$(state_file api-pickup-group)"
api PATCH "/ringGroups/$group_id" '{"ringTimeoutS": 10}' >/dev/null
bash "$here/_api-control-setup.sh" "$api_base" "$token" "$compose" pickup "$uas"
if [ -n "$ring_timeout_s" ]; then
  api PATCH "/users/$(colleague_id colleague)" "{\"ringTimeoutS\": $ring_timeout_s}" >/dev/null
fi
