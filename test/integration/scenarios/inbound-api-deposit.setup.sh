#!/usr/bin/env bash
# §10.1 "Transfers and pickup" over the API, into a mailbox: the messages 101's mailbox holds
# before the call, for the check to find the new one, and the transfer itself started in the
# background, waiting for the call (`_api-control.sh deposit`).
set -euo pipefail

api_base=$1
token=$2
compose=$4
here=$(dirname "$0")
# shellcheck source=_lib.sh
. "$here/_lib.sh"

api GET /voicemails | python3 -c '
import json, sys
print(" ".join(v["id"] for v in json.load(sys.stdin)["items"]))
' > "$(state_file api-deposit-before)"
bash "$here/_api-control-setup.sh" "$api_base" "$token" "$compose" deposit
