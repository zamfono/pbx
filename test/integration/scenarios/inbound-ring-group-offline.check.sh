#!/usr/bin/env bash
# §10.1 step 5: with both members offline, the group's `unavailable` rule sent the call to its
# mailbox at once, without offering it to any phone.
set -euo pipefail

read -r _ _ group_id _ _ _ < /tmp/zamfono-offline
bash "$(dirname "$0")/_unavailable-check.sh" "$1" "$2" "$3" "$group_id" 20
