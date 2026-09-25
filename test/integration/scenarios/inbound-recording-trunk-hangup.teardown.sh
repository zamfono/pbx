#!/usr/bin/env bash
# Undoes `inbound-recording-trunk-hangup.setup.sh`: the member records no more calls.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

api PATCH "/users/$(user_with_ext 101)" '{"recordCalls": false}' >/dev/null
rm -f "$(state_file recording-before)"
