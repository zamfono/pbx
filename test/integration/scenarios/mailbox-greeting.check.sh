#!/usr/bin/env bash
# §10.2 "Mailbox access": the greeting 101 recorded over `*96` is their mailbox's greeting now,
# shared with the REST API, and the feature call is in the history as 101's own: from their
# extension, not from the device's SIP username (§11.2 `calls.from_uri`, §9.3 caller ID), and
# answered, though the caller left it by hanging up.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"


api GET /calls | python3 -c '
import json, sys
calls = json.load(sys.stdin)["items"]
call = next((c for c in calls if c["toUri"] == "*96"), None)
if call is None:
    sys.exit("no *96 call in the history")
problems = []
if call["fromUri"] != "101":
    problems.append("the call came from " + repr(call["fromUri"]) + ", not the extension 101")
if call["status"] != "answered":
    problems.append("the call ended " + repr(call["status"]) + ", not answered")
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(call))
'

user_id=$(user_with_ext 101)
greeting=$(api GET "/users/$user_id" | jsonfield mailboxAudioId)
case $greeting in
  '' | None)
    # The keys the menu took and what became of the recording are in the call's routing trace.
    call_id=$(api GET /calls | python3 -c '
import json, sys
print(next(c["id"] for c in json.load(sys.stdin)["items"] if c["toUri"] == "*96"))
')
    echo "the greeting recorded over *96 is not 101's mailbox greeting;" \
      "trace: $(api GET "/calls/$call_id" | jsonfield log)" >&2
    exit 1
    ;;
  *) ;;
esac
