#!/usr/bin/env bash
# §10.2 "Voicemail", §11.2 `calls.status`: a caller who ends the message by hanging up leaves a
# `voicemails` row, and the call ends in the mailbox, `voicemail`, not `missed`, even though the
# caller's channel went before the recording's outcome arrived.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

call=$(newest_call)
voicemails=$(api GET /voicemails)
python3 -c '
import json, sys
call = json.loads(sys.argv[1])
voicemails = json.loads(sys.argv[2])["items"]
problems = []
if call["status"] != "voicemail":
    problems.append("the call ended " + call["status"] + ", not in the mailbox")
if not call["endedAt"]:
    problems.append("the call was never closed")
if not any(v["createdAt"] >= call["startedAt"] and v["caller"] == call["fromUri"]
           for v in voicemails):
    problems.append("no voicemail was left for the call")
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(call)[:600])
' "$call" "$voicemails"
