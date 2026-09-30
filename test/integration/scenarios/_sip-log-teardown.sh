#!/usr/bin/env bash
# Undoes `_sip-log-setup.sh`: the tenant's previous `callLogLevel`.
#   _sip-log-teardown.sh API TOKEN NAME
set -euo pipefail

api_base=$1
token=$2
name=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

previous=$(cat "$(state_file "$name-level")")
api PATCH /settings "{\"callLogLevel\":\"$previous\"}" >/dev/null
rm -f "$(state_file "$name-level")"
