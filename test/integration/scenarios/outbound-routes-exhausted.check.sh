#!/usr/bin/env bash
# §9.4 "Cross-trunk failover": the call's one matching route (the catch-all, over `ci-trunk`)
# failed with 403 before any alerting, so the core answered the caller itself, played the
# failed-call announcement and released the call. Asserts: the scratch verbose log
# (`outbound-routes-exhausted.setup.sh`'s `ci-announce` channel) shows `please-try-call-later`
# played in the channel language `es_female`, the Spanish generated set (§9.1) rather than another
# language's file; and the history entry `calls.status` reads `failed`, what §9.4 says a failed
# outbound call gets.
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

# The logger's own queue flushes to the file a little after the event itself, so this polls
# rather than reading once.
played=''
# Whether the verbose log shows the announcement, what it played left in `played`.
announced() {
  played=$(dc exec -T asterisk sh -c 'cat /var/log/asterisk/ci-announce 2>/dev/null || true' \
    | tr -d '\r' | grep 'Playing ' || true)
  printf '%s\n' "$played" | grep -q "Playing 'please-try-call-later\.[a-z0-9]*' (language 'es_female')"
}

if ! poll 10 1 announced; then
  echo "the caller never heard the Spanish failed-call announcement: ${played:-nothing played}" >&2
  exit 1
fi

newest_call | python3 -c '
import json, sys

call = json.load(sys.stdin)
to, status = call["toUri"], call["status"]
problems = []
if to != "+15557301":
    problems.append(f"the newest call went to {to!r}, not +15557301")
if status != "failed":
    problems.append(f"the call ended {status!r}, not failed")
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(call))
'
