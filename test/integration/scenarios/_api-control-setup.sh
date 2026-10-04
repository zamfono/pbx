#!/usr/bin/env bash
# Shared setup of the `inbound-api-*` scenarios (§10.3 "Live calls"): with `<colleague-uas>`, a
# colleague, 102, with a phone of their own beside 101's (`_colleague.sh`'s `add_colleague`) served by
# that phone scenario; then the live-call action itself started in the background, waiting for
# the call (`_api-control.sh <mode>`, given `<arg>` where the mode takes one).
#
# Usage: _api-control-setup.sh <api-base> <token> <compose> <mode> [<colleague-uas> [<arg>]]
set -euo pipefail

api_base=$1
token=$2
compose=$3
mode=$4
uas=${5:-}
arg=${6:-}
here=$(dirname "$0")
# shellcheck source=_colleague.sh
. "$here/_colleague.sh"

if [ -n "$uas" ]; then
  add_colleague 'CI Colleague' api-control@ci.test 102 colleague
  serve_colleague "$uas" colleague
fi
rm -f "$(state_file api-control)"
# Detached from the setup's own output, which `run-scenarios.sh` reads to its end.
nohup bash "$here/_api-control.sh" "$api_base" "$token" "$compose" "$mode" "$arg" \
  </dev/null >"$(state_file api-control.log)" 2>&1 &
