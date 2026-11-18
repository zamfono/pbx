#!/usr/bin/env bash
# §10.6 "After-call requests": once the call was over and its recording written, the target's
# after-call request reached the receiver, one POST for the one attempt: signed under the
# request's secret, with the secret header's value and the templated header rendered for the
# call, its URL template filled in, and the call's record as its body, the call without its log,
# the attempt as answered at the number dialled, and the one recording with both links. The
# receiver downloaded the recording through its link, a WAV, and deleted it through the other, at
# once and without confirmation: the link then opens nothing, the history holds no recording of
# the call any more, and the delete is in the audit log as the after-call request's.
set -euo pipefail

api_base=$1
token=$2
compose=$3
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

call_id=$(await_new_call "$(cat "$(state_file recording-before)")" 15)
# The request waits for the recording's mix, then the receiver uses the links before it notes it.
poll 30 1 http_request_noted \
  || { echo "no after-call request reached the receiver within 30 s" >&2; exit 1; }
recordings=$(api GET "/recordings?callId=$call_id")
audit=$(api GET '/audit?operation=recordings.delete')
printf '%s' "$received" | python3 -c '
import hashlib, hmac, json, sys

call_id, recordings, audit = sys.argv[1], json.loads(sys.argv[2]), json.loads(sys.argv[3])
requests = [json.loads(line) for line in sys.stdin.read().splitlines() if line.strip()]
problems = []
if len(requests) != 1:
    sys.exit("the receiver got %d requests, not one: %s" % (len(requests), json.dumps(requests)))
request = requests[0]
headers, body = request["headers"], request["body"]
if (request["method"], request["url"]) != ("POST", "/calls?did=%2B15551011"):
    problems.append("the request is %s %s" % (request["method"], request["url"]))
signature = hmac.new(b"ci-after-call-secret", body.encode(), hashlib.sha256).hexdigest()
if headers.get("x-zamfono-signature") != signature:
    problems.append("the signature does not verify under the secret")
if headers.get("authorization") != "Bearer ci-token":
    problems.append("the secret header did not arrive with its value")
if headers.get("x-caller") != "+15559999 via 181":
    problems.append("the templated header reads %r" % headers.get("x-caller"))
record = json.loads(body)
if record.get("id") != call_id or "log" in record:
    problems.append("the body is not the call without its log")
target = record.get("target", {})
if (target.get("kind"), target.get("external"), target.get("outcome"), target.get("cause")) != (
    "external", "+15557777", "answered", None):
    problems.append("the attempt reads %s" % json.dumps(target))
if "values" in target:
    problems.append("the attempt carries its template values")
if len(record.get("recordings", [])) != 1:
    problems.append("the record lists %d recordings" % len(record.get("recordings", [])))
links = request.get("links", {})
if links.get("download") != 200 or links.get("riff") != "RIFF" or links.get("audioBytes", 0) < 8000:
    problems.append("the download link did not answer the recording: %s" % json.dumps(links))
if links.get("delete") != 200:
    problems.append("the delete link answered %s" % links.get("delete"))
if links.get("downloadAfterDelete") != 404:
    problems.append("the recording still downloads after its delete")
if recordings["items"]:
    problems.append("the call still has a recording")
entries = [e for e in audit["items"] if e["entityId"] == links.get("recordingId")]
if len(entries) != 1 or not entries[0]["actorUserName"].startswith("after-call request of forward target "):
    problems.append("the delete is not audited as the after-call request: %s" % json.dumps(entries))
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(request))
' "$call_id" "$recordings" "$audit"
