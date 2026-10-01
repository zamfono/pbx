#!/usr/bin/env bash
# §10.1 "Transfers and pickup" over the API, attended: the consultation and the transfer to it
# were accepted, the call the member answered closed with the transfer in its trace, and the
# consultation carried the conversation on as its child, answered by the colleague
# (`_api-control-check.py consult`).
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

read -r call_id consultation <<<"$(bash "$(dirname "$0")/_api-control-check.sh" 2)"
original_file=$(mktemp)
consultation_file=$(mktemp)
trap 'rm -f "$original_file" "$consultation_file"' EXIT
await_ended_call "$call_id" 15 > "$original_file"
await_ended_call "$consultation" 15 > "$consultation_file"
python3 "$(dirname "$0")/_api-control-check.py" consult "$(user_with_ext 101)" \
  "$(colleague_id colleague)" "$original_file" "$consultation_file"
