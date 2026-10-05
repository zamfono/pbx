#!/usr/bin/env bash
# Removes what `_recording-forward-setup.sh` created: 181's forward, then the DID pointed away
# from 181, who presents it as their number since it was their first (§9.4 "Caller-ID"), so 181
# can go, and the DID after them.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

state=$(state_file recording-forward)
read -r user_id did_id < "$state"
api PUT "/users/$user_id/forwarding" '{"rules":[]}' >/dev/null
api PATCH "/dids/$did_id" '{"target":{"kind":"external","external":"+15550000"}}' >/dev/null
api_delete "/users/$user_id"
api_delete "/dids/$did_id"
rm -f "$state" "$(state_file recording-before)"
