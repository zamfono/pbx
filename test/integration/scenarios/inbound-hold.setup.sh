#!/usr/bin/env bash
# §10.2 "Hold music": one of the bundled tracks, seeded at first boot as a `moh` audio asset
# (§6.3), becomes the tenant's hold music, and the answering device's endpoint suggests its class
# once the PATCH answered, which is what it re-renders and propagates (§9.1). Asterisk's verbose
# log at level 3, which names the class every music-on-hold start plays, goes to a scratch log
# channel for the check to read; `core set verbose` would raise only the CLI console's own level.
set -euo pipefail

api_base=$1
token=$2
compose=$4
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

moh_id=$(api GET /audio | python3 -c '
import json, sys
print([a["id"] for a in json.load(sys.stdin)["items"] if a["kind"] == "moh"][0])
')
api PATCH /settings "{\"holdMohAudioId\": \"$moh_id\"}" >/dev/null

member_id=$(user_with_ext 101)
sip_username=$(api GET "/users/$member_id/devices" | jsonfield items.0.sipUsername)
# Read whole before matching: under pipefail, Podman's compose provider reports the SIGPIPE an
# early-exiting `grep -q` leaves the CLI as a failure.
# shellcheck disable=SC2086 # `$compose` carries the runtime's own multi-word command
endpoint=$($compose exec -T asterisk asterisk -rx "pjsip show endpoint $sip_username")
printf '%s\n' "$endpoint" | grep -Eq "moh_suggest +: +$moh_id" || {
  echo "endpoint $sip_username does not suggest hold class $moh_id once the PATCH answered" >&2
  exit 1
}

# shellcheck disable=SC2086 # see above
$compose exec -T asterisk sh -c \
  "asterisk -rx 'logger add channel ci-hold verbose(3)' >/dev/null"
printf '%s\n' "$moh_id" > "$(state_file hold)"
