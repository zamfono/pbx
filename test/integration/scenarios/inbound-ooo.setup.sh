#!/usr/bin/env bash
# §8 "OOO": an out-of-office rule on the ring group, sending the call to the group's mailbox
# instead of ringing anyone. Records the rule's id for the teardown.
set -euo pipefail

api_base=$1
token=$2

# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

group_id=$(api GET /ringGroups | jsonfield items.0.id)

rule_id=$(api POST "/ringGroups/$group_id/ooo" "{
  \"active\": true,
  \"target\": { \"kind\": \"mailboxRingGroup\", \"ringGroupId\": \"$group_id\" }
}" | jsonfield id)

printf '%s\n' "$rule_id" > "$(state_file ooo-rule)"
