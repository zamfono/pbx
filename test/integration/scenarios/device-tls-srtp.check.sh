#!/usr/bin/env bash
# §3, §9.1 transport-tls, §9.3/§10.4: the four things a TLS/SRTP device's call must show that no
# other scenario's sipp phone can —
#   (a) the registration itself is over TLS (`pjsip show aor`'s own contact URI)
#   (b) the endpoint's policy is SDES-SRTP (`pjsip show endpoint`) and the call it just carried
#       actually negotiated it (the device's own SIP trace, since the channel is gone by now)
#   (c) that leg's codec is Opus, the device's only one (same trace)
#   (d) the recording semantics §10.2 already covers for a wideband leg, reused as
#       `inbound-recording-wideband.check.sh` does (16 kHz; `_recording-check.sh`, extended with
#       an extension argument for a member who isn't `user_with_ext`'s usual 101)
set -euo pipefail

api_base=$1
token=$2
compose=$3
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

EXT=106
read -r _ _ sip_username _ < "$(state_file tls-srtp)"

fail() {
  echo "$1" >&2
  exit 1
}

# `pjsip show contacts`' own table truncates the contact URI at a fixed column width, cutting off
# exactly the `;transport=` parameter this checks; the AOR's own `contact` field (`pjsip show
# aor`) is the same URI in full.
aor=$(asterisk_cli "pjsip show aor $sip_username")
contact_line=$(printf '%s' "$aor" | grep '^ contact ' || true)
[ -n "$contact_line" ] || fail "no contact for AOR $sip_username: $aor"
printf '%s' "$contact_line" | grep -i 'transport=tls' >/dev/null \
  || fail "the device's contact isn't transport=tls: $contact_line"

# shellcheck disable=SC2086
endpoint=$(asterisk_cli "pjsip show endpoint $sip_username")
media_encryption_line=$(printf '%s' "$endpoint" | grep media_encryption || true)
printf '%s' "$media_encryption_line" | grep 'sdes' >/dev/null \
  || fail "endpoint $sip_username isn't media_encryption=sdes: $media_encryption_line"

# The device's own SIP trace (`-s`, `device-tls-srtp.setup.sh`) of the call this scenario's xml
# just placed: whichever side's SDP it appears in, an `RTP/SAVP` media line with an `a=crypto`
# attribute is SDES-SRTP actually negotiated, not merely configured, and an `opus` rtpmap is the
# codec the bridge carried on this leg (the device offers/accepts nothing else).
# shellcheck disable=SC2086
trace=$(dc exec -T devices sh -c 'cat /root/.baresip/baresip.log')
printf '%s' "$trace" | grep 'RTP/SAVP' >/dev/null \
  || fail "the device's trace never shows RTP/SAVP: $(printf '%s' "$trace" | tail -c 800)"
printf '%s' "$trace" | grep 'a=crypto:' >/dev/null \
  || fail "the device's trace never shows a crypto line: $(printf '%s' "$trace" | tail -c 800)"
printf '%s' "$trace" | grep -i 'opus/48000' >/dev/null \
  || fail "the device's trace never shows an Opus rtpmap: $(printf '%s' "$trace" | tail -c 800)"

bash "$here/_recording-check.sh" "$1" "$2" "$3" 16000 "$EXT"
