#!/usr/bin/env bash
# Deletes the picking user `inbound-pickup.setup.sh` created, and with them their device.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

api_delete "/users/$(cat "$(state_file picker-user)")"
rm -f "$(state_file picker-user)"
