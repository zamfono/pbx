#!/usr/bin/env bash
# Clears the forwarding `inbound-forward-external.setup.sh` set.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

api PUT "/users/$(cat "$(state_file forward-user)")/forwarding" '{"rules":[]}' >/dev/null
rm -f "$(state_file forward-user)"
