#!/usr/bin/env bash
# Undoes `inbound-api-park.setup.sh`: the colleague and their phone are deleted, and the group's
# diagnostics level is the tenant default again.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

remove_colleague colleague
api PATCH "/ringGroups/$(ci_group)" '{"logLevel": null}' >/dev/null
rm -f "$(state_file api-park)" "$(state_file api-park-list)" "$(state_file api-park.log)"
