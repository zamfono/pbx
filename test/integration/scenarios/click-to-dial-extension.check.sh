#!/usr/bin/env bash
# §10.2 "Click-to-dial": the originated call is one `calls` row from 101 to 102, answered by the
# colleague's phone; its trace names the actor, the device it rang and the one that answered.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

api GET "/calls/$(cat "$(state_file originated)")" \
  | python3 "$(dirname "$0")/_originate-check.py" "$(user_with_ext 101)" 102 answered \
    "$(colleague_id colleague)"
