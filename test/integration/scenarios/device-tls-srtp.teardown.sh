#!/usr/bin/env bash
# Undoes `device-tls-srtp.setup.sh`: stops the baresip device, then removes the DID and the user
# (whose device is removed with it, §5.8).
set -euo pipefail

api_base=$1
token=$2
compose=$3
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

read -r user_id did_id _ _ < "$(state_file tls-srtp)"

dc exec -T devices sh -c 'pkill baresip || true'
# Creating the DID made it the user's own caller-ID (a `kind: user` target's own side effect),
# and the DID's own target is this same user: each refuses to delete while the other still
# references it (§5.9), so the caller-ID reference is cleared first to break the cycle.
api PATCH "/users/$user_id" '{"calleridDidId": null}' >/dev/null
api_delete "/dids/$did_id"
api_delete "/users/$user_id"
rm -f "$(state_file tls-srtp)" "$(state_file recording-before)"
