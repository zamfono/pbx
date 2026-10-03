#!/usr/bin/env bash
# Undoes `inbound-api-decline.setup.sh`: the ring group's strategy, turn and members are what they
# were, and the decliner and their phone are deleted.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_colleague.sh
. "$(dirname "$0")/_colleague.sh"

api PATCH "/ringGroups/$(ci_group)" "$(python3 -c '
import json, sys
group = json.load(open(sys.argv[1]))
print(json.dumps({
    "strategy": group["strategy"],
    "ringTimeoutS": group["ringTimeoutS"],
    "members": [{"kind": m["kind"], "id": m["id"]} for m in group["members"]],
}))
' "$(state_file api-decline-group)")" >/dev/null
remove_colleague decliner
rm -f "$(state_file api-decline-group)"
bash "$(dirname "$0")/_api-control-teardown.sh" "$api_base" "$token"
