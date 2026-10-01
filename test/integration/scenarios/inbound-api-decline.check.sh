#!/usr/bin/env bash
# §10.1 step 5 with a decline over the API: the decliner's decline was accepted, their leg
# ended as a 603 would end it, and the group moved on to 101, who answered well within the
# decliner's own 20 s turn (`_api-control-check.py decline`).
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

accepted=$(bash "$(dirname "$0")/_api-control-check.sh" 1)
read -r call_id <<<"$accepted"
call_file=$(mktemp)
trap 'rm -f "$call_file"' EXIT
await_ended_call "$call_id" 15 > "$call_file"
python3 "$(dirname "$0")/_api-control-check.py" decline "$(colleague_id decliner)" \
  "$(user_with_ext 101)" "$call_file" 15
