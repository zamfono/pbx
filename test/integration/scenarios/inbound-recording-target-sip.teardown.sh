#!/usr/bin/env bash
# Undoes `inbound-recording-target-sip.setup.sh`.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

state=$(state_file recording-target)
api_delete "/dids/$(cat "$state")"
rm -f "$state" "$(state_file recording-before)"
