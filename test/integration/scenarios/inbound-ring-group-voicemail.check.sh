#!/usr/bin/env bash
# §8 "no answer → voicemail": the group rings the phone (its `.roles` plays `ring-no-answer`) past
# its ring timeout without an answer and falls through to the group's own mailbox (§10.1 step 5,
# the implicit `unanswered` default), where the caller's silence lets the mailbox's own 5 s
# silence stop end the recording (§10.2 "Voicemail").
set -euo pipefail

api_base=$1
token=$2
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

group_id=$(ci_group)
voicemails=$(api GET /voicemails)
newest_call | python3 -c '
import json, sys

group, voicemails = sys.argv[1], json.loads(sys.argv[2])
call = json.load(sys.stdin)

problems = []
if call["ringGroupId"] != group:
    problems.append("the call did not reach the group")
if call["status"] != "voicemail":
    problems.append("the call ended " + call["status"] + ", not in the group mailbox")
if not call["endedAt"]:
    problems.append("the call was never closed")
if not any(v["mailboxRingGroupId"] == group for v in voicemails["items"]):
    problems.append("the group mailbox holds no message")
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(call)[:600])
' "$group_id" "$voicemails"
