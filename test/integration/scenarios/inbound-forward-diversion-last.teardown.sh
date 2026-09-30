#!/usr/bin/env bash
# Removes what `inbound-forward-diversion-last.setup.sh` created: 178's forward, both users, with
# them 177's out-of-office rule, and the DID; then puts the routes back, so no route uses the
# trunk any more (§5.9), and removes the trunk.
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

state=$(state_file inbound-forward-diversion-last)
routes=$(state_file inbound-forward-diversion-last-routes)
read -r trunk_id forwarder agent did_id < "$state"
api PUT "/users/$agent/forwarding" '{"rules":[]}' >/dev/null
# The DID points at 177, who presents it as their number since it was their first (§9.4
# "Caller-ID"): it is pointed elsewhere, so 177 can go, and goes once 177 no longer presents it.
api PATCH "/dids/$did_id" '{"target":{"kind":"external","external":"+15550000"}}' >/dev/null
api_delete "/users/$forwarder"
api_delete "/users/$agent"
api_delete "/dids/$did_id"
put_routes "$(cat "$routes")"
api_delete "/trunks/$trunk_id"
rm -f "$state" "$routes"
