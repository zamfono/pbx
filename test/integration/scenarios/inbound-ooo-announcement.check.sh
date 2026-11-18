#!/usr/bin/env bash
# §10.1 step 7 "Announcement and hangup": the out-of-office rule's target played its announcement
# and the call then went where the target sends it, the group's mailbox, with no phone rung, as
# `inbound-ooo` ends. The trace's `announce` line, naming the asset, is where the announcement
# shows after the call, and it comes before the mailbox's own lines.
set -euo pipefail

api_base=$1
token=$2
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

group_id=$(ci_group)
bash "$here/_unavailable-check.sh" "$1" "$2" "$3" "$group_id" 25

read -r _ audio_id < "$(state_file ooo-announcement)"
newest_call | PYTHONPATH="$here" python3 -c '
import json, sys
from _call_trace import trace

audio_id = sys.argv[1]
call = json.load(sys.stdin)
events = [e.get("event") for e in trace(call)]
announced = [e for e in trace(call) if e.get("event") == "announce" and e.get("audioId") == audio_id]
if len(announced) != 1:
    sys.exit("the announcement was not played exactly once: " + json.dumps(events))
if events.index("announce") < events.index("ooo"):
    sys.exit("the announcement played before the rule applied its target: " + json.dumps(events))
' "$audio_id"
