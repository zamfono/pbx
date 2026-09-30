#!/usr/bin/env bash
# §10.2 "Click-to-dial": the originated call is one `calls` row from 101 to the number, answered
# over the trunk; its trace names the actor, the device it rang and the one that answered, and
# the trunk leg's answer (§7). At level `qos` (the setup) both legs have a `call_qos` row, and
# since both sides spoke, each measured its jitter and loss (`_qos-check.sh`).
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

api GET "/calls/$(cat "$(state_file originated)")" \
  | python3 "$(dirname "$0")/_originate-check.py" "$(user_with_ext 101)" +15557501 answered trunk
bash "$(dirname "$0")/_qos-check.sh" "$1" "$2" measured
