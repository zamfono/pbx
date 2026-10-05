#!/usr/bin/env bash
# Undoes `click-to-dial-leg-transfer.setup.sh`: the colleague and their phone are deleted, the
# background action's state is gone (`_api-control-teardown.sh`), and so is the originated call's.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

bash "$(dirname "$0")/_api-control-teardown.sh" "$api_base" "$token"
rm -f "$(state_file originated)"
