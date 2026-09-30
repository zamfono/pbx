#!/usr/bin/env bash
# Undoes `click-to-dial-external.setup.sh`: 101's diagnostics level is the tenant default again.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

api PATCH "/users/$(user_with_ext 101)" '{"logLevel": null}' >/dev/null
rm -f "$(state_file originated)"
