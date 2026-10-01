#!/usr/bin/env bash
# Shared check of the `*-sip-log-*` scenarios (§7 level `sip`): `_sip-log-check.py` against the
# scenario's call. A call at this level closes a few seconds after it ends, and the history lists
# it once it has closed, its SIP messages in its log; so the check waits for a call newer than the
# one `_sip-log-setup.sh` noted, and asserts on it once.
#   _sip-log-check.sh API TOKEN NAME TO '<direction> <first-line regex>'...
set -euo pipefail

api_base=$1
token=$2
name=$3
shift 3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

call_id=$(await_new_call "$(cat "$(state_file "$name-before")")" 20)
api GET "/calls/$call_id" | python3 "$(dirname "$0")/_sip-log-check.py" "$@"
