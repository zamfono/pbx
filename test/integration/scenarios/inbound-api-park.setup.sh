#!/usr/bin/env bash
# §10.2 "Call parking" over the API: a colleague, 102, with a phone of their own beside 101's
# (`_lib.sh`'s `add_colleague`), which answers the retrieval and speaks (`answer-speak`) until the
# caller hangs up. The ring group routing the call raises it to diagnostics level `qos` (§7), so
# the check reads what each leg received. The park and retrieval start in the background, waiting
# for the call (`_api-park.sh`).
set -euo pipefail

api_base=$1
token=$2
compose=$4
here=$(dirname "$0")
# shellcheck source=_lib.sh
. "$here/_lib.sh"

add_colleague 'CI Retriever' api-retriever@ci.test 102 colleague
serve_colleague answer-speak colleague
api PATCH "/ringGroups/$(ci_group)" '{"logLevel": "qos"}' >/dev/null
rm -f "$(state_file api-park)" "$(state_file api-park-list)"
# Detached from the setup's own output, which `run-scenarios.sh` reads to its end.
nohup bash "$here/_api-park.sh" "$api_base" "$token" \
  </dev/null >"$(state_file api-park.log)" 2>&1 &
