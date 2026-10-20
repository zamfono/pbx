#!/usr/bin/env bash
# Undoes `inbound-ssrc-switch.setup.sh`: stops its baresip device and removes the captures, the
# DID and the user (whose device is removed with it, §5.8).
set -euo pipefail

api_base=$1
token=$2
compose=$3
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

read -r user_id did_id _ < "$(state_file ssrc-switch)"

# The bracket keeps the pattern from matching this `sh -c`'s own command line.
dc exec -T devices sh -c 'pkill -f "baresip -f /root/[.]baresip-ssrc" || true'
dc exec -T sipp rm -rf /tmp/ssrc-switch
# The DID and the user reference each other (`device-tls-srtp.teardown.sh`).
api PATCH "/users/$user_id" '{"callerIdDidId": null}' >/dev/null
api_delete "/dids/$did_id"
api_delete "/users/$user_id"
rm -f "$(state_file ssrc-switch)"
