#!/usr/bin/env bash
# §10.2 "Greetings and audio", "Mailbox access": 101's mailbox greets with an upload first, read by
# ffmpeg as the WAV it is declared and transcoded next to its master, so the greeting recorded over
# `*96` replaces it; the check finds it deleted, row and files (§5.9).
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

wav=$(mktemp --suffix .wav)
trap 'rm -f "$wav"' EXIT
python3 - "$wav" <<'PY'
import sys, wave
with wave.open(sys.argv[1], "wb") as out:
    out.setnchannels(1)
    out.setsampwidth(2)
    out.setframerate(8000)
    out.writeframes(bytes(2 * 8000))
PY
user_id=$(user_with_ext 101)
greeting=$(curl -fsS -X PUT "$api_base/api/v1/users/$user_id/voicemailGreeting" "${FWD[@]}" \
  -H "Authorization: Bearer $token" -F "upload=@$wav;type=audio/wav" | jsonfield mailboxAudioId)
files=$(dc exec -T core ls /media/prompts </dev/null | grep -c "^$greeting\." || true)
[ "$files" = 2 ] || {
  echo "the uploaded greeting $greeting left $files files in prompts/, not its master and WAV" >&2
  exit 1
}
echo "$greeting" > "$(state_file mailbox-greeting)"
