#!/usr/bin/env bash
# The menu the two menu-hangup scenarios call into (§10.1 step 6): a 10 s greeting, a 2 s
# timeout, `$5` attempts, and a fallback that rings 101, so a menu that went on after its caller
# left would offer the phone a call. DID `$4` points at it. Records the menu and DID ids under
# the state file `$3` names.
#
# Usage: _menu-setup.sh <api-base> <token> <state-key> <did> <max-attempts>
set -euo pipefail

api_base=$1
token=$2
state_key=$3
did=$4
max_attempts=$5
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

GREETING_S=10

# One greeting for both scenarios, uploaded the first time.
audio_id=$(api GET /audio | python3 -c "
import json, sys
print(next((a['id'] for a in json.load(sys.stdin)['items'] if a['label'] == 'ci-menu-greeting'), ''))
")
if [ -z "$audio_id" ]; then
  wav=$(mktemp --suffix .wav)
  trap 'rm -f "$wav"' EXIT
  python3 - "$wav" "$GREETING_S" <<'PY'
import math, struct, sys, wave
path, seconds = sys.argv[1], int(sys.argv[2])
with wave.open(path, "wb") as out:
    out.setnchannels(1)
    out.setsampwidth(2)
    out.setframerate(8000)
    out.writeframes(b"".join(
        struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * n / 8000)))
        for n in range(8000 * seconds)))
PY
  audio_id=$(curl -fsS -X POST "$api_base/api/v1/audio" -H 'X-Forwarded-For: 127.0.0.1' \
    -H "Authorization: Bearer $token" -F kind=announcement -F label=ci-menu-greeting \
    -F "upload=@$wav;type=audio/wav" | jsonfield id)
fi

member_id=$(user_with_ext 101)
menu_id=$(api POST /menus "{
  \"name\": \"ci-menu-$state_key\",
  \"audioId\": \"$audio_id\",
  \"timeoutS\": 2,
  \"maxAttempts\": $max_attempts,
  \"fallbackTarget\": { \"kind\": \"user\", \"userId\": \"$member_id\" }
}" | jsonfield id)
did_id=$(api POST /dids \
  "{\"number\":\"$did\",\"target\":{\"kind\":\"menu\",\"menuId\":\"$menu_id\"}}" | jsonfield id)
printf '%s %s\n' "$menu_id" "$did_id" > "$(state_file "$state_key")"
