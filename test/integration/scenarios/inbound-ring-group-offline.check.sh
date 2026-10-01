#!/usr/bin/env bash
# §10.1 step 5: with both members offline, the group's `unavailable` rule sent the call to its
# mailbox at once, without offering it to any phone.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

read -r _ _ group_id _ _ _ < "$(state_file offline)"
bash "$(dirname "$0")/_unavailable-check.sh" "$1" "$2" "$3" "$group_id" 20
