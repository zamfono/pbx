#!/usr/bin/env bash
# The history check the `inbound-api-pickup*` scenarios share: the background pickup
# (`_api-control.sh pickup`) was accepted, and the call it was for records what came of it
# (`_api-pickup-check.py`).
#
# Usage: _api-pickup-check.sh <api-base> <token> <outcome>
set -euo pipefail

api_base=$1
token=$2
outcome=$3
here=$(dirname "$0")
# shellcheck source=_colleague.sh
. "$here/_colleague.sh"

accepted=$(bash "$here/_api-control-check.sh" 1)
read -r call_id <<<"$accepted"
await_ended_call "$call_id" 15 \
  | python3 "$here/_api-pickup-check.py" "$(colleague_id colleague)" "$outcome"
