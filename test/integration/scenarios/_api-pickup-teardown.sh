#!/usr/bin/env bash
# Undoes `_api-pickup-setup.sh`: the ring group's timeout is what it was, and the colleague and
# their phone are deleted (`_api-control-teardown.sh`).
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

api PATCH "/ringGroups/$(ci_group)" \
  "{\"ringTimeoutS\": $(cat "$(state_file api-pickup-group)")}" >/dev/null
rm -f "$(state_file api-pickup-group)"
bash "$(dirname "$0")/_api-control-teardown.sh" "$api_base" "$token"
