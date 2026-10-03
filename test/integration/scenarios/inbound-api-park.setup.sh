#!/usr/bin/env bash
# §10.2 "Call parking" over the API: a colleague, 102, with a phone of their own beside 101's,
# which answers the retrieval and speaks (`answer-speak`) until the caller hangs up. The ring
# group routing the call raises it to diagnostics level `qos` (§7), so the check reads what each
# leg received. The park and retrieval start in the background, waiting for the call
# (`_api-control.sh park`).
set -euo pipefail

api_base=$1
token=$2
compose=$3
here=$(dirname "$0")
# shellcheck source=_lib.sh
. "$here/_lib.sh"

api PATCH "/ringGroups/$(ci_group)" '{"logLevel": "qos"}' >/dev/null
bash "$here/_api-control-setup.sh" "$api_base" "$token" "$compose" park answer-speak
