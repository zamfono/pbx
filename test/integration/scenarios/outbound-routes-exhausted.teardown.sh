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

asterisk_cli 'logger remove channel ci-announce' >/dev/null
dc exec -T asterisk rm -f /var/log/asterisk/ci-announce
rm -f "$(state_file routes-exhausted-language)"
