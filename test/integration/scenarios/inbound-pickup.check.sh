#!/usr/bin/env bash
# §10.1 "Transfers and pickup", pickup: `*8101` finds the call ringing 101 through the ring group
# and answers it for the picker, whom its `calls` row records as `answered_by_user_id`. The
# picker hung up, which ended the call for its caller too, so the row is closed.
set -euo pipefail

api_base=$1
token=$2
compose=$3

# The picker's own call (`uas/pickup-dial.sh`) ran beside the ringing device's; it hung up just
# before the stack ended the caller's call, so its exit status follows within moments.
code=''
for _ in $(seq 1 10); do
  # shellcheck disable=SC2086 # `$compose` carries the runtime's own multi-word command
  if code=$($compose exec -T sipp-phone cat /tmp/pickup-dial.exit 2>/dev/null); then
    break
  fi
  sleep 1
done
code=$(printf '%s' "$code" | tr -d '\r')
if [ "$code" != 0 ]; then
  echo "the picker's own call did not complete (sipp exit '${code:-none}')" >&2
  exit 1
fi

picker_id=$(cat /tmp/zamfono-picker-user)
curl -fsS "$api_base/api/v1/calls" -H 'X-Forwarded-For: 127.0.0.1' \
  -H "Authorization: Bearer $token" | python3 -c '
import json, sys
picker = sys.argv[1]
calls = json.load(sys.stdin)["items"]
# Newest first: the most recent call that reached the group is the one this scenario placed.
picked = next((c for c in calls if c["ringGroupId"]), None)
if picked is None:
    sys.exit("no call reached the ring group")
problems = []
if picked["status"] != "answered":
    problems.append("the picked-up call was not recorded as answered")
if picked["answeredByUserId"] != picker:
    problems.append("the picked-up call does not name the picker as its answerer")
if not picked["endedAt"]:
    problems.append("the picked-up call was never closed")
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(picked))
' "$picker_id"
