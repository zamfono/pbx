#!/usr/bin/env bash
# test/load/stress: what each step saves as proof that the profile really ran (sourced by
# stress/session.sh after lib-stack.sh): negotiated codecs and transcoding per leg, signalling
# transport per leg, SRTP on the device legs, confirmed concurrency, recording state and storage.
# shellcheck shell=bash

MEDIA_REC_DIR=${MEDIA_REC_DIR:-}

ast() { dc exec -T asterisk asterisk -rx "$1" 2>/dev/null | tr -d '\r'; }

# Bridged call legs only: Snoop/ channels (two per recorded participation, §10.2) and any
# Local/ helpers are counted separately.
pjsip_channels() { ast 'core show channels concise' | grep -c '^PJSIP/'; }
snoop_channels() { ast 'core show channels concise' | grep -c '^Snoop/'; }

# One trunk leg and one device leg: formats, transcoding path, and the PJSIP-level details.
evidence_legs() {
  local out=$1 concise trunk device ch
  concise=$(ast 'core show channels concise')
  trunk=$(printf '%s\n' "$concise" | cut -d'!' -f1 | grep -m1 '^PJSIP/trunk-')
  device=$(printf '%s\n' "$concise" | cut -d'!' -f1 | grep -m1 -E '^PJSIP/e[0-9]+-d')
  {
    echo "--- $(date -u +%T) core show channels count"
    ast 'core show channels count'
    echo "PJSIP legs: $(printf '%s\n' "$concise" | grep -c '^PJSIP/')"
    echo "Snoop channels: $(printf '%s\n' "$concise" | grep -c '^Snoop/')"
    for ch in $trunk $device; do
      echo "--- core show channel $ch"
      ast "core show channel $ch" | grep -E 'Name:|NativeFormats|WriteFormat|ReadFormat|WriteTranscode|ReadTranscode|State:|BRIDGEPEER|SIPCALLID'
      echo "--- pjsip show channel ${ch#PJSIP/}"
      ast "pjsip show channel ${ch#PJSIP/}" | sed -n '1,40p'
    done
    echo '--- pjsip show channelstats (head)'
    ast 'pjsip show channelstats' | head -12
    echo '--- device contacts (transport)'
    ast 'pjsip show contacts' | awk '$1 == "Contact:" && $2 ~ /^e[0-9]+-d/' | head -5
    echo '--- trunk endpoint / device endpoint codecs + encryption'
    for ch in $trunk $device; do
      ast "pjsip show endpoint $(printf '%s' "${ch#PJSIP/}" | sed 's/-[0-9a-f]\{8\}$//')" \
        | grep -E '^ *(allow|media_encryption|transport) *:'
    done
  } >> "$out"
}

# Size of the in-progress raw pair (-l/-r) and of finished mixes, in bytes; file counts too.
media_sizes() {
  local dir=$MEDIA_REC_DIR raw=0 rawn=0 mix=0 mixn=0
  if [ -d "$dir" ]; then
    raw=$(find "$dir" -name '*-[lr].wav' -printf '%s\n' | awk '{s+=$1} END {print s+0}')
    rawn=$(find "$dir" -name '*-[lr].wav' | wc -l)
    mix=$(find "$dir" -name '*.wav' ! -name '*-[lr].wav' -printf '%s\n' | awk '{s+=$1} END {print s+0}')
    mixn=$(find "$dir" -name '*.wav' ! -name '*-[lr].wav' | wc -l)
  fi
  echo "raw_bytes=$raw raw_files=$rawn mixed_bytes=$mix mixed_files=$mixn media_volume=$(du -sb "${dir%/*}" 2>/dev/null | cut -f1)"
}

recordings_count() {
  api GET '/recordings?limit=1000' 2>/dev/null \
    | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["items"]))' 2>/dev/null || echo '?'
}

recordings_dump() {
  api GET '/recordings?limit=1000' 2>/dev/null > "$1" || true
}

mix_failures() {
  curl -fsS "$api_base/metrics" "${FWD[@]}" -H "Authorization: Bearer $METRICS_TOKEN" 2>/dev/null \
    | awk '$1 == "zamfono_recording_mix_failures_total" { print $2; f=1 } END { if (!f) print "?" }'
}
