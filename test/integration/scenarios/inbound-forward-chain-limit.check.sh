#!/usr/bin/env bash
# §10.1 step 7: hops 1-3 (chain0→chain1→chain2→chain3, each re-entering the pipeline through its
# own unconditional rule) reach `MAX_HOPS` at chain3, "the last target" the third hop leaves the
# call at. Its own unconditional rule, the fourth forward (chain3→chain4), is over the limit:
# chain4 is never entered and never rung, and the call goes to chain3's own mailbox instead.
set -euo pipefail

api_base=$1
token=$2
compose=$3
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

read -r _ _ _ _ id3 _ < "$(state_file forward-chain-limit)"

invites=$(bash "$here/../phone.sh" "$compose" invites)
[ "$invites" = 0 ] || { echo "the phone was sent $invites INVITE(s)" >&2; exit 1; }

voicemails=$(api GET /voicemails)
newest_call | python3 -c '
import json, sys

last_target, voicemails = sys.argv[1], json.loads(sys.argv[2])
call = json.load(sys.stdin)

problems = []
if call["status"] != "voicemail":
    problems.append("the call ended " + call["status"] + ", not in a mailbox")
if not call["endedAt"]:
    problems.append("the call was never closed")
if not any(v["mailboxUserId"] == last_target for v in voicemails["items"]):
    problems.append("the last target (chain3) has no voicemail message")
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(call)[:600])
' "$id3" "$voicemails"
