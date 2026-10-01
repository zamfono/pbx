#!/usr/bin/env bash
# §10.3 "Live calls", hold over the API: the hold and the resume were accepted; while held, the
# caller's trunk channel played the class of `settings.hold_moh_audio_id`
# (`inbound-hold.check.sh`) and was out of the bridge, the member alone in it; once resumed, the
# bridge held both again, so audio flowed both ways; the call's trace names both, each with its
# actor (`_api-control-check.py hold`).
set -euo pipefail

api_base=$1
token=$2
here=$(dirname "$0")
# shellcheck source=_lib.sh
. "$here/_lib.sh"

accepted=$(bash "$here/_api-control-check.sh" 2)
read -r call_id while_held resumed <<<"$accepted"
if [ "${while_held:-}" != 1 ] || [ "${resumed:-}" != 2 ]; then
  echo "the bridge held ${while_held:-?} channels while on hold and ${resumed:-?} once resumed," \
    "not 1 and 2" >&2
  exit 1
fi
bash "$here/inbound-hold.check.sh" "$@"
call_file=$(mktemp)
trap 'rm -f "$call_file"' EXIT
await_ended_call "$call_id" 15 > "$call_file"
python3 "$here/_api-control-check.py" hold "$(user_with_ext 101)" "$call_file"
