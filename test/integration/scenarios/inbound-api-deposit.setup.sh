#!/usr/bin/env bash
# §10.1 "Transfers and pickup" over the API, into a mailbox: the messages 101's mailbox holds
# before the call, for the check to find the new one, and the transfer itself started in the
# background, waiting for the call (`_api-deposit.sh`).
set -euo pipefail

api_base=$1
token=$2
here=$(dirname "$0")
# shellcheck source=_lib.sh
. "$here/_lib.sh"

api GET /voicemails | python3 -c '
import json, sys
print(" ".join(v["id"] for v in json.load(sys.stdin)["items"]))
' > "$(state_file api-deposit-before)"
rm -f "$(state_file api-deposit)"
# Detached from the setup's own output, which `run-scenarios.sh` reads to its end.
nohup bash "$here/_api-deposit.sh" "$api_base" "$token" \
  </dev/null >"$(state_file api-deposit.log)" 2>&1 &
