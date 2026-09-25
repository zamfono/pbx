#!/usr/bin/env bash
# §9.4 "Route fallthrough": the 403, which Asterisk reports as the same Q.850 cause as a 603, was
# read as the provider's refusal and the call went on to the second route; there, 100 and 183
# held the attempt past the 8-second budget until the 200. The routing trace has one line per
# attempt: `ci-trunk` with cause 403, then the second trunk answered, and nothing in between.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

first_id=$(trunk_named ci-trunk)
second_id=$(cat "$(state_file fallthrough)")
newest_call | python3 -c '
import json, sys

first, second = sys.argv[1:3]
call = json.load(sys.stdin)
attempts = []
for line in (call.get("log") or "").splitlines():
    try:
        entry = json.loads(line)
    except ValueError:
        continue
    if isinstance(entry, dict) and entry.get("event") == "attempt":
        attempts.append((entry.get("trunkId"), entry.get("cause")))

to, status = call["toUri"], call["status"]
problems = []
if to != "+15557201":
    problems.append(f"the newest call went to {to!r}, not +15557201")
if status != "answered":
    problems.append(f"the call ended {status!r}, not answered")
if attempts != [(first, 403), (second, "answered")]:
    problems.append(f"the attempts were {attempts}, not a 403 on {first} then an answer on {second}")
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(call))
' "$first_id" "$second_id"
