#!/usr/bin/env bash
# Removes the DID, forwarding rules and users `inbound-forward-chain-limit.setup.sh` created.
# Forwarding is cleared before any user is deleted: `chain0`'s live rule still names `chain1` as
# its target (soft-deleting `chain0` does not touch it, §5.9 "their own forwarding rule ...
# deleted with them" only excuses `chain0`'s own delete, not `chain1`'s), and a user a live
# `forward_targets` row still names is refused with 409 (`findUserReferences`). A DID that targets
# a user becomes their presented number when they have none (§9.4 "Caller-ID"), which `chain0` had
# none of, so its `calleridDidId` is cleared before the DID goes too, the same way
# `inbound-decline-no-answer.teardown.sh` restores it.
set -euo pipefail

api_base=$1
token=$2
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

read -r did_id id0 id1 id2 id3 id4 < "$(state_file forward-chain-limit)"

for id in "$id0" "$id1" "$id2" "$id3"; do
  api PUT "/users/$id/forwarding" '{"rules":[]}' >/dev/null
done

api PATCH "/users/$id0" '{"calleridDidId":null}' >/dev/null
api_delete "/dids/$did_id"
for id in "$id0" "$id1" "$id2" "$id3" "$id4"; do
  api_delete "/users/$id"
done

rm -f "$(state_file forward-chain-limit)"
