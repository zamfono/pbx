#!/usr/bin/env bash
# Undoes `inbound-hold.setup.sh`: the static default class again, and the scratch log channel
# removed.
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

api PATCH /settings '{"holdMohAudioId": null}' >/dev/null
# The PATCH reloads PJSIP; the next scenario's own write reloads it again, and a reload Asterisk
# receives while one is still running is refused, so the teardown returns once this one landed.
member_id=$(user_with_ext 101)
sip_username=$(api GET "/users/$member_id/devices" | jsonfield items.0.sipUsername)
for _ in $(seq 1 30); do
  # shellcheck disable=SC2086 -- `$compose` carries the runtime's own multi-word command
  if $compose exec -T asterisk asterisk -rx "pjsip show endpoint $sip_username" 2>/dev/null \
    | grep -Eq 'moh_suggest +: +default'; then
    break
  fi
  sleep 1
done
# shellcheck disable=SC2086 -- `$compose` carries the runtime's own multi-word command
$compose exec -T asterisk sh -c \
  "asterisk -rx 'logger remove channel ci-hold' >/dev/null; rm -f /var/log/asterisk/ci-hold"
rm -f "$(state_file hold)"
