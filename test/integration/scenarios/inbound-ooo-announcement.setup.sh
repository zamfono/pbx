#!/usr/bin/env bash
# §10.1 step 7 "Announcement and hangup": an out-of-office rule on the ring group whose target,
# the group's mailbox, names an announcement of two seconds, which the caller hears first. Records
# the rule's and the asset's ids for the teardown.
set -euo pipefail

api_base=$1
token=$2

# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

wav=$(mktemp --suffix .wav)
trap 'rm -f "$wav"' EXIT
python3 - "$wav" <<'PY'
import math, struct, sys, wave
with wave.open(sys.argv[1], "wb") as out:
    out.setnchannels(1)
    out.setsampwidth(2)
    out.setframerate(8000)
    out.writeframes(b"".join(
        struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * n / 8000)))
        for n in range(8000 * 2)))
PY
audio_id=$(curl -fsS -X POST "$api_base/api/v1/audio" "${FWD[@]}" \
  -H "Authorization: Bearer $token" -F kind=announcement -F label=ci-ooo-announcement \
  -F "upload=@$wav;type=audio/wav" | jsonfield id)

group_id=$(api GET /ringGroups | jsonfield items.0.id)

rule_id=$(api POST "/ringGroups/$group_id/ooo" "{
  \"active\": true,
  \"target\": {
    \"kind\": \"mailboxRingGroup\",
    \"ringGroupId\": \"$group_id\",
    \"announcementAudioId\": \"$audio_id\"
  }
}" | jsonfield id)

printf '%s %s\n' "$rule_id" "$audio_id" > "$(state_file ooo-announcement)"
