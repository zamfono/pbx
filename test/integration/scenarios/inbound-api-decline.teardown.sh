#!/usr/bin/env bash
# Undoes `inbound-api-decline.setup.sh`: the ring group's strategy, turn and members are what they
# were, and the owner's phone is deleted; the owner keeps extension 109.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

api PATCH "/ringGroups/$(ci_group)" "$(python3 -c '
import json, sys
group = json.load(open(sys.argv[1]))
print(json.dumps({
    "strategy": group["strategy"],
    "ringTimeoutS": group["ringTimeoutS"],
    "members": [{"kind": m["kind"], "id": m["id"]} for m in group["members"]],
}))
' "$(state_file api-decline-group)")" >/dev/null
api_delete "/devices/$(cat "$(state_file api-decline-device)")"
rm -f "$(state_file api-decline-group)" "$(state_file api-decline-device)" \
  "$(state_file decliner)"
bash "$(dirname "$0")/_api-control-teardown.sh" "$1" "$2"
