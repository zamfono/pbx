#!/usr/bin/env bash
# Undoes `inbound-api-leg-transfer.setup.sh`: the DID is deleted, and the background action's
# state is gone (`_api-control-teardown.sh`).
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

api_delete "/dids/$(cat "$(state_file leg-transfer-did)")"
rm -f "$(state_file leg-transfer-did)"
bash "$(dirname "$0")/_api-control-teardown.sh" "$api_base" "$token"
