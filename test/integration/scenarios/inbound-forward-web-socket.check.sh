#!/usr/bin/env bash
# §9.4 "WebSocket targets", §5.2 "Session tokens": the call to +15551090 was answered by the bot.
# The bot got `websocket:connected` at 16 kHz with the caller, the DID, its session token and both
# leg ids, and the caller's voice as little-endian PCM: a voice is smooth from sample to sample,
# its bytes swapped it is noise. Its `notify` came back once its tone had played, and its session
# token hung the call up (200). The history: answered, by nobody, through the `webSocket` leg, and
# one recording whose far-end channel holds the bot's 1 kHz tone, smooth, so it reached Asterisk
# in RTP's byte order.
set -euo pipefail

api_base=$1
token=$2
compose=$3
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

poll 30 1 dc exec -T sip-tls test -e /tmp/voice-bot/result.json \
  || { echo "the voice bot's socket never closed" >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
dc exec -T sip-tls cat /tmp/voice-bot/result.json >"$work/result.json"
dc exec -T sip-tls cat /tmp/voice-bot/caller.raw >"$work/caller.raw"

call_id=$(await_new_call "$(cat "$(state_file recording-before)")" 15)
api GET "/calls/$call_id" >"$work/call.json"
# The call's one recording, once its mix has stored the row; fails until then.
call_recording() {
  api GET /recordings | python3 -c '
import json, sys
ids = [r["id"] for r in json.load(sys.stdin)["items"] if r["callId"] == sys.argv[1]]
print(ids[0]) if len(ids) == 1 else sys.exit(1)
' "$call_id"
}
poll 30 1 call_recording >/dev/null \
  || { echo "call $call_id left no single recording" >&2; exit 1; }
recording_id=$(call_recording)
api GET "/recordings/$recording_id/audio" >"$work/recording.wav"

PYTHONPATH="$here" python3 - "$work" "$call_id" <<'PY'
import json, struct, sys
from _call_trace import trace

work, call_id = sys.argv[1], sys.argv[2]
problems = []
result = json.load(open(f"{work}/result.json"))
connected = result["connected"] or {}
expected = {
    "event": "websocket:connected",
    "content-type": "audio/l16;rate=16000",
    "callerNumber": "+15559999",
    "did": "+15551090",
    "callId": call_id,
}
for key, value in expected.items():
    if connected.get(key) != value:
        problems.append(f"connected {key} is {connected.get(key)!r}, not {value!r}")
if not str(connected.get("sessionToken", "")).startswith("zcs_"):
    problems.append("connected carries no session token")
if not connected.get("callerLegId") or not connected.get("botLegId"):
    problems.append("connected carries no leg ids")
if result["path"] != "/calls?token=ci":
    problems.append(f"the bot was asked for {result['path']}")
if result["notified"] != {"played": "tone"}:
    problems.append(f"the notify came back as {result['notified']!r}")
if result["hangup"] != 200:
    problems.append(f"the session token's hangup answered {result['hangup']}")

def roughness(samples):
    """Mean step between neighbouring samples over mean magnitude: well under 1 for a voice or a
    tone at 16 kHz, about 1 or more for the same samples with their bytes swapped."""
    loud = sum(abs(s) for s in samples) / len(samples)
    steps = sum(abs(a - b) for a, b in zip(samples, samples[1:])) / (len(samples) - 1)
    return steps / loud if loud else float("inf")

raw = open(f"{work}/caller.raw", "rb").read()
caller = list(struct.unpack(f"<{len(raw) // 2}h", raw[: len(raw) // 2 * 2]))
if len(raw) < 16000 * 2:
    problems.append(f"the bot received {len(raw)} bytes of the caller, not a second of it")
elif roughness(caller) > 0.6:
    problems.append(f"the caller's audio is noise at the bot (roughness {roughness(caller):.2f})")

wav = open(f"{work}/recording.wav", "rb").read()
at, fmt, frames = 12, None, b""
while at + 8 <= len(wav):
    chunk, size = wav[at:at + 4], struct.unpack("<I", wav[at + 4:at + 8])[0]
    if chunk == b"fmt ":
        fmt = struct.unpack("<HHI", wav[at + 8:at + 16])
    elif chunk == b"data":
        frames = wav[at + 8:at + 8 + size]
    at += 8 + size + size % 2
_, channels, rate = fmt
samples = struct.unpack(f"<{len(frames) // 2}h", frames[: len(frames) // 2 * 2])
left = list(samples[0::channels])
tone = [s for s in left if abs(s) > 2000]
if len(tone) < rate // 2:
    problems.append(f"the recording's far-end channel holds no tone ({len(tone)} loud samples)")
else:
    loud = [i for i, s in enumerate(left) if abs(s) > 2000]
    segment = left[loud[0]:loud[0] + rate]
    crossings = sum(1 for a, b in zip(segment, segment[1:]) if (a < 0) != (b < 0))
    if not 1800 <= crossings * rate / len(segment) <= 2200:
        problems.append(f"the far-end tone crosses zero {crossings} times a second, not about 2000")

call = json.load(open(f"{work}/call.json"))
answered = [e for e in trace(call) if e.get("event") == "answered"]
if call["status"] != "answered" or call["answeredByUserId"] is not None:
    problems.append(f"the call ended {call['status']}, answered by {call['answeredByUserId']}")
if len(answered) != 1 or answered[0].get("leg") != "webSocket" or answered[0].get("protocol") != "vonage":
    problems.append(f"answered lines: {answered}")
if problems:
    sys.exit("; ".join(problems))
PY
