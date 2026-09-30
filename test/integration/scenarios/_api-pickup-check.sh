#!/usr/bin/env bash
# The history check the `inbound-api-pickup*` scenarios share: the background pickup
# (`_api-pickup.sh`) was accepted, and the call it was for records what came of it
# (`_api-pickup-check.py`).
#
# Usage: _api-pickup-check.sh <api-base> <token> <outcome>
set -euo pipefail

api_base=$1
token=$2
outcome=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

read -r code call_id < "$(state_file api-pickup)" || true
if [[ ${code:-none} != 2?? ]]; then
  echo "the API pickup was not accepted (HTTP ${code:-none}):" \
    "$(cat "$(state_file api-pickup.log)" 2>/dev/null)" >&2
  exit 1
fi
await_ended_call "$call_id" 15 \
  | python3 "$(dirname "$0")/_api-pickup-check.py" "$(colleague_id colleague)" "$outcome"
