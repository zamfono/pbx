#!/usr/bin/env bash
# §8 "forwarding chains": the ring group's only member forwards unconditionally to an external
# number, so the call leaves again over the trunk instead of ringing the member's device.
set -euo pipefail

api_base=$1
token=$2

# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

user_id=$(user_with_ext 101)

api PUT "/users/$user_id/forwarding" \
  '{"rules":[{"condition":"unconditional","target":{"kind":"external","external":"+15557777"}}]}' \
  >/dev/null
printf '%s\n' "$user_id" > "$(state_file forward-user)"
