#!/usr/bin/env bash
# §10.2 "Hold music": while the softphone held the caller, Asterisk played the caller's trunk
# channel the class of `settings.hold_moh_audio_id`, not the static default class.
set -euo pipefail

compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

moh_id=$(cat "$(state_file hold)")
started=$(dc exec -T asterisk sh -c 'cat /var/log/asterisk/ci-hold 2>/dev/null || true' \
  | tr -d '\r' | grep 'Started music on hold' || true)
if ! printf '%s\n' "$started" | grep -q "class '$moh_id', on channel 'PJSIP/trunk-"; then
  echo "the held caller's trunk channel never played hold class $moh_id: ${started:-no music on hold started}" >&2
  exit 1
fi
