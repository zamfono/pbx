#!/usr/bin/env bash
# §9.4 "Cross-trunk failover": the call's one matching route (the catch-all, over `ci-trunk`)
# failed with 403 before any alerting, so the core answered the caller itself and played ITU-T
# E.180's special information tone — the `de` tenant's prompt set has no `please-try-call-later`
# — for about `SIT_DURATION_MS` (indications.ts), then released the call. Asserts: the scratch
# verbose log (`outbound-routes-exhausted.setup.sh`'s `ci-tone` channel) names the tone's own
# media, `tone:info;tonezone=itu`, and never the announcement's `please-try-call-later`; the
# call's own duration is close to `SIT_DURATION_MS`, not an instant release nor a stuck one; and
# the history entry `calls.status` reads `failed`, what §9.4 says a failed outbound call gets.
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

# The logger's own queue (`logger show channels`' "Logger queue limit") flushes to the file a
# little after the event itself — the call is already fully torn down (`assert_no_channels`) by
# the time this runs, but the PlaybackFinished line can still be on its way, so this polls rather
# than reading once.
tone_log=''
for _ in $(seq 1 10); do
  # shellcheck disable=SC2086 -- `$compose` carries the runtime's own multi-word command
  tone_log=$($compose exec -T asterisk sh -c 'cat /var/log/asterisk/ci-tone 2>/dev/null || true' \
    | tr -d '\r')
  printf '%s\n' "$tone_log" | grep -q 'tone:info;tonezone=itu' && break
  sleep 1
done

if ! printf '%s\n' "$tone_log" | grep -q 'tone:info;tonezone=itu'; then
  echo "the verbose log never named the special information tone: ${tone_log:-empty}" >&2
  exit 1
fi
if printf '%s\n' "$tone_log" | grep -q 'please-try-call-later'; then
  echo "the verbose log played the failed-call announcement instead of the tone: $tone_log" >&2
  exit 1
fi

newest_call | python3 -c '
import datetime, json, sys

call = json.load(sys.stdin)
to, status = call["toUri"], call["status"]
problems = []
if to != "+15557301":
    problems.append(f"the newest call went to {to!r}, not +15557301")
if status != "failed":
    problems.append(f"the call ended {status!r}, not failed")

started, ended = call["startedAt"], call["endedAt"]
if started is None or ended is None:
    problems.append(f"the call is missing startedAt/endedAt: {started!r}/{ended!r}")
else:
    duration = (
        datetime.datetime.fromisoformat(ended.replace("Z", "+00:00"))
        - datetime.datetime.fromisoformat(started.replace("Z", "+00:00"))
    ).total_seconds()
    # SIT_DURATION_MS (indications.ts) is three cycles of 950/1400/1800 Hz plus silence, ~5.97 s;
    # the 403 that exhausts the one matching route and the release that follows the tone both add
    # a little on top, so the tolerance is wide (~5-9 s) rather than pinned to the exact figure.
    if not 5 <= duration <= 9:
        problems.append(f"the call lasted {duration:.1f}s, not ~6s (5-9s) of special information tone")

if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(call))
'
