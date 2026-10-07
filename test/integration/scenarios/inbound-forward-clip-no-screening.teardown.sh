#!/usr/bin/env bash
# Removes what `inbound-forward-clip-no-screening.setup.sh` created: 179's forward, 179 and both
# DIDs; then puts the routes back, so no route uses the trunk any more (§5.9), and removes the trunk.
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

state=$(state_file inbound-forward-clip-no-screening)
routes=$(state_file inbound-forward-clip-no-screening-routes)
read -r trunk_id forwarder did_id line_id < "$state"
api PUT "/users/$forwarder/forwarding" '{"rules":[]}' >/dev/null
# The DID points at 179, who presents it as their number since it was their first (§9.4
# "Caller-ID"): it is pointed elsewhere, so 179 can go, and goes once 179 no longer presents it.
api PATCH "/dids/$did_id" '{"target":{"kind":"external","external":"+15550000"}}' >/dev/null
api_delete "/users/$forwarder"
api_delete "/dids/$did_id"
api_delete "/dids/$line_id"
put_routes "$(cat "$routes")"
api_delete "/trunks/$trunk_id"
rm -f "$state" "$routes"
