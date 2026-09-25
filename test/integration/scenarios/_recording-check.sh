#!/usr/bin/env bash
# The history check the recording scenarios share (§10.2 "Recording semantics"): the answering
# user's participation ended when the trunk side hung up, and it yields exactly one `recordings`
# row, whose file is playable stereo audio ("a recordings row asserts that a playable file
# exists") at the sample rate `$4` the call's codecs call for ("Sample rate"), and whose
# `durationS` is that file's own length (§11.2 `recordings.duration_s`). The mix runs once
# the participation's snoops have stopped, a moment after the call's channels are gone, so the
# row is waited for.
#
# Usage: _recording-check.sh <api-base> <token> <compose> <sample-rate-hz> [<member-extension>]
set -euo pipefail

api_base=$1
token=$2
rate_hz=$4
member_ext=${5:-101}
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

# Half a second of the 16-bit stereo mix: a file of headers alone (a mix of an empty channel
# ends at once) is no playable recording of a call the trunk side spoke on for seconds.
MIN_AUDIO_BYTES=$((rate_hz * 2 * 2 / 2))

# The history lists a call once it has ended, which is once its participations are stored: the
# channels, which the harness waited out, go first.
before=$(cat "$(state_file recording-before)")
call_id=$before
for _ in $(seq 1 15); do
  call_id=$(api GET /calls | jsonfield items.0.id)
  [ "$call_id" != "$before" ] && break
  sleep 1
done
[ "$call_id" != "$before" ] || {
  echo "the scenario's call never reached the history" >&2
  exit 1
}
member_id=$(user_with_ext "$member_ext")
# The call's own recordings, one `<id> <userId> <durationS>` line each.
call_recordings() {
  api GET /recordings | python3 -c '
import json, sys
for r in json.load(sys.stdin)["items"]:
    if r["callId"] == sys.argv[1]:
        print(r["id"], r["userId"] or "-", r["durationS"])
' "$call_id"
}
for _ in $(seq 1 15); do
  [ -n "$(call_recordings)" ] && break
  sleep 1
done
# A second, later row would be the participation recorded twice.
sleep 2
recordings=$(call_recordings)
rows=$(printf '%s' "$recordings" | grep -c . || true)
[ "$rows" -eq 1 ] || {
  echo "call $call_id left $rows recordings rows, not exactly one" >&2
  exit 1
}
read -r recording_id recording_user duration_s <<<"$recordings"
[ "$recording_user" = "$member_id" ] || {
  echo "recording $recording_id is user $recording_user's, not the member's" >&2
  exit 1
}
audio=$(mktemp)
trap 'rm -f "$audio"' EXIT
api GET "/recordings/$recording_id/audio" >"$audio"
bytes=$(wc -c <"$audio")
[ "$bytes" -ge "$MIN_AUDIO_BYTES" ] || {
  echo "recording $recording_id holds $bytes bytes, not the call's audio" >&2
  exit 1
}
# The stored WAV's own `fmt ` chunk, its channel count and sample rate, and its `data` chunk's
# length in whole seconds of that format.
read -r channels file_rate_hz audio_s < <(python3 -c '
import struct, sys
data = open(sys.argv[1], "rb").read()
at, fmt, data_bytes = 12, None, 0
while at + 8 <= len(data):
    chunk, size = data[at:at + 4], struct.unpack("<I", data[at + 4:at + 8])[0]
    if chunk == b"fmt ":
        fmt = struct.unpack("<HIIH", data[at + 10:at + 22])
    elif chunk == b"data":
        data_bytes = min(size, len(data) - at - 8)
    at += 8 + size + size % 2
channels, rate, _, block_align = fmt
print(channels, rate, round(data_bytes / block_align / rate))
' "$audio")
format="$channels $file_rate_hz"
[ "$format" = "2 $rate_hz" ] || {
  echo "recording $recording_id is \"$format\" (channels, Hz), not stereo at $rate_hz Hz" >&2
  exit 1
}
# Asterisk's own `RecordingFinished` duration counts a 16 kHz file's samples at 8 kHz, doubling
# it: the row must carry the mix's length, a second either way for the rounding.
[ $((duration_s - audio_s)) -le 1 ] && [ $((audio_s - duration_s)) -le 1 ] || {
  echo "recording $recording_id has durationS $duration_s, its file ${audio_s} s of audio" >&2
  exit 1
}
