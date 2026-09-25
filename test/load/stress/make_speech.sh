#!/usr/bin/env bash
# test/load: builds the speech-like source audio the stress profile's media generators encode:
# Asterisk's own English G.722 (wideband) prompts, pulled from the asterisk image, concatenated
# into one continuous talker. Writes two files into <out_dir>:
#   speech16k.wav  16 kHz mono s16 -- make_amrwb_pcap.py's input (trunk side, AMR-WB)
#   speech48k.wav  48 kHz mono s16, looped to <seconds> -- baresip's aufile source (devices,
#                  Opus); longer than any call, since aufile stops sending at end of file
# Usage: make_speech.sh <asterisk-image> <out_dir> <seconds>
set -euo pipefail

runtime=${RUNTIME:-docker}  # docker or podman: the store the image lives in

image=$1
out_dir=$2
seconds=$3
work=$(mktemp -d "${TMPDIR:-/tmp}/zamfono-speech.XXXXXX")
trap 'rm -rf "$work"' EXIT

# tar -h follows the sounds directory's symlinks on both runtimes (`podman cp` has no -L).
mkdir "$work/en"
"$runtime" run --rm --entrypoint tar "$image" -chf - -C /usr/share/asterisk/sounds/en . \
  | tar -xf - -C "$work/en"

list="$work/list.txt"
: > "$list"
count=0
for f in "$work"/en/*.g722; do
  ffmpeg -loglevel error -f g722 -i "$f" -ar 16000 -ac 1 "$work/p$count.wav"
  echo "file '$work/p$count.wav'" >> "$list"
  count=$((count + 1))
  [ "$count" -ge 40 ] && break
done

ffmpeg -loglevel error -y -f concat -safe 0 -i "$list" -ar 16000 -ac 1 -c:a pcm_s16le \
  "$out_dir/speech16k.wav"
ffmpeg -loglevel error -y -stream_loop -1 -i "$out_dir/speech16k.wav" -t "$seconds" \
  -ar 48000 -ac 1 -c:a pcm_s16le "$out_dir/speech48k.wav"
echo "speech: $count prompts, $(du -h "$out_dir/speech16k.wav" | cut -f1) / $(du -h "$out_dir/speech48k.wav" | cut -f1)" >&2
