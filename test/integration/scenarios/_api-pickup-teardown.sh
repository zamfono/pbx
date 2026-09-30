#!/usr/bin/env bash
# Undoes `_api-pickup-setup.sh`: the colleague and their phone are deleted, and the ring group's
# timeout is what it was.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

remove_colleague colleague
api PATCH "/ringGroups/$(ci_group)" \
  "{\"ringTimeoutS\": $(cat "$(state_file api-pickup-group)")}" >/dev/null
rm -f "$(state_file api-pickup-group)" "$(state_file api-pickup)" "$(state_file api-pickup.log)"
