#!/usr/bin/env bash
# Undoes `inbound-api-park.setup.sh`: the group's diagnostics level is the tenant default again,
# and the colleague and their phone are deleted (`_api-control-teardown.sh`).
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

api PATCH "/ringGroups/$(ci_group)" '{"logLevel": null}' >/dev/null
bash "$(dirname "$0")/_api-control-teardown.sh" "$api_base" "$token"
