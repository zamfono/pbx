#!/usr/bin/env bash
# Undoes `_api-control-setup.sh`: the colleague, if it added one, and their phone are deleted, and
# the background action's state is gone.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

if [ -f "$(state_file colleague)" ]; then
  remove_colleague colleague
fi
rm -f "$(state_file api-control)" "$(state_file api-control.log)" \
  "$(state_file api-control.parked)"
