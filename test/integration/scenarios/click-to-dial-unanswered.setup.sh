#!/usr/bin/env bash
# §10.2 "Click-to-dial" whose own ring goes unanswered: 101's ring timeout (§11.2
# `users.ring_timeout_s`) is shortened, so the phone that never answers (`ring-no-answer`) rings
# out within seconds. The timeout in place before is kept for the teardown.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

member_id=$(user_with_ext 101)
api GET "/users/$member_id" | python3 -c '
import json, sys
body = json.load(sys.stdin)
print((body.get("user") or body)["ringTimeoutS"])
' > "$(state_file ring-timeout)"
api PATCH "/users/$member_id" '{"ringTimeoutS": 5}' >/dev/null
