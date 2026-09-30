#!/usr/bin/env bash
# Deletes the colleague `click-to-dial-extension.setup.sh` created, and with them their phone.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

remove_colleague colleague
rm -f "$(state_file originated)"
