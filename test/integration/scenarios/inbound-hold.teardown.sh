#!/usr/bin/env bash
# Undoes `inbound-hold.setup.sh`: the static default class again, which the answering device's
# endpoint suggests once the PATCH answered, and the scratch log channel removed.
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

api PATCH /settings '{"holdMohAudioId": null}' >/dev/null
member_id=$(user_with_ext 101)
sip_username=$(api GET "/users/$member_id/devices" | jsonfield items.0.sipUsername)
endpoint=$(asterisk_cli "pjsip show endpoint $sip_username")
printf '%s\n' "$endpoint" | grep -Eq 'moh_suggest +: +default' || {
  echo "endpoint $sip_username does not suggest the default class once the PATCH answered" >&2
  exit 1
}
dc exec -T asterisk sh -c \
  "asterisk -rx 'logger remove channel ci-hold' >/dev/null; rm -f /var/log/asterisk/ci-hold"
rm -f "$(state_file hold)"
