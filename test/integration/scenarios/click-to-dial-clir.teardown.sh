#!/usr/bin/env bash
# Puts the routes back and removes the trunk `click-to-dial-clir.setup.sh` created.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

put_routes "$(cat "$(state_file clir-routes)")"
api_delete "/trunks/$(cat "$(state_file clir-trunk)")"
rm -f "$(state_file clir-trunk)" "$(state_file clir-routes)" "$(state_file originated)"
