#!/usr/bin/env bash
# Shared setup of the `*-sip-log-*` scenarios (§7 level `sip`): the tenant's `callLogLevel`
# raised to `sip`, the way an operator raises it, so the call records the SIP messages Asterisk
# mirrors to the core over HEP; the level in place before is kept for `_sip-log-teardown.sh`.
#   _sip-log-setup.sh API TOKEN NAME
set -euo pipefail

api_base=$1
token=$2
name=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

api GET /settings | jsonfield callLogLevel > "$(state_file "$name-level")"
api PATCH /settings '{"callLogLevel":"sip"}' >/dev/null
