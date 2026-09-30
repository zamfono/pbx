#!/usr/bin/env bash
# §10.2 "Click-to-dial": a ring on the user's own phone that nobody answers leaves the call in the
# history as `failed`, its trace naming the actor and the phone it rang, and saying the ring went
# unanswered.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

api GET "/calls/$(cat "$(state_file originated)")" \
  | python3 "$(dirname "$0")/_originate-check.py" "$(user_with_ext 101)" +15557502 unanswered
