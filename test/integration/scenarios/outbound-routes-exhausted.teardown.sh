#!/usr/bin/env bash
# Undoes `outbound-routes-exhausted.setup.sh`: the tenant's previous language and the scratch log
# channel removed.
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

previous=$(cat "$(state_file routes-exhausted-language)")
api PATCH "/settings" "{\"language\":\"$previous\"}" >/dev/null

# shellcheck disable=SC2086 # `$compose` carries the runtime's own multi-word command
$compose exec -T asterisk sh -c "
  asterisk -rx 'logger remove channel ci-tone' >/dev/null
  rm -f /var/log/asterisk/ci-tone
  asterisk -rx 'core set debug 0 res_stasis_playback' >/dev/null
"
rm -f "$(state_file routes-exhausted-language)"
