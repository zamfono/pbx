#!/usr/bin/env bash
# Undoes `click-to-dial-unanswered.setup.sh`: 101's ring timeout is what it was.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

api PATCH "/users/$(user_with_ext 101)" \
  "{\"ringTimeoutS\": $(cat "$(state_file ring-timeout)")}" >/dev/null
rm -f "$(state_file ring-timeout)" "$(state_file originated)"
