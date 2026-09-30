#!/usr/bin/env bash
# Removes what `inbound-forward-sip.setup.sh` created: 178's forward first, since a trunk a live
# `sip` target dials over cannot be deleted (§5.9), then both users, with them 177's
# out-of-office rule, the DID and the trunk; and the TLS front with its certificate.
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

state=$(state_file inbound-forward-sip)
read -r trunk_id forwarder agent did_id < "$state"
api PUT "/users/$agent/forwarding" '{"rules":[]}' >/dev/null
# The DID points at 177, who presents it as their number since it was their first (§9.4
# "Caller-ID"): it is pointed elsewhere, so 177 can go, and goes once 177 no longer presents it.
api PATCH "/dids/$did_id" '{"target":{"kind":"external","external":"+15550000"}}' >/dev/null
api_delete "/users/$forwarder"
api_delete "/users/$agent"
api_delete "/dids/$did_id"
api_delete "/trunks/$trunk_id"
# shellcheck disable=SC2086 -- `$compose` carries the runtime's own multi-word command
$compose exec -T sip-tls sh -c 'kill "$(cat /tmp/sip-target-tls/front.pid)"; rm -rf /tmp/sip-target-tls'
# shellcheck disable=SC2086
$compose exec -T sipp rm -f /tmp/sip-target-messages.log
rm -f "$state"
