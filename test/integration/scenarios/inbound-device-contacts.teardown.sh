#!/usr/bin/env bash
# Undoes `inbound-device-contacts.setup.sh`: stops both baresip phones and the answerer, then
# removes the DID and the user (whose device is removed with it, §5.8).
set -euo pipefail

api_base=$1
token=$2
compose=$3
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

read -r user_id did_id < "$(state_file device-contacts)"

dc exec -T devices sh -c 'pkill baresip; pkill -x python3; true'
# The DID became the user's own caller-ID and targets the user, so the reference is cleared
# first (`device-tls-srtp.teardown.sh`).
api PATCH "/users/$user_id" '{"callerIdDidId": null}' >/dev/null
api_delete "/dids/$did_id"
api_delete "/users/$user_id"
rm -f "$(state_file device-contacts)"
