#!/usr/bin/env bash
# §10.2 "Click-to-dial": the user's only phone declining ends the call at once, `failed`, its
# trace naming the actor, the phone it rang and its decline (§7 "answers and declines"), and
# saying the ring went unanswered; the call does not ring on until the timeout (`_originate.sh`
# gave it 15 s, less than 101's 25 s ring timeout).
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

api GET "/calls/$(cat "$(state_file originated)")" \
  | python3 "$(dirname "$0")/_originate-check.py" "$(user_with_ext 101)" +15557503 declined
rm -f "$(state_file originated)"
