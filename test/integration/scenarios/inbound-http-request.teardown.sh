#!/usr/bin/env bash
# Removes what `inbound-http-request.setup.sh` created, the DID before the request its target
# names and the request before the decision its own target names, and stops the receiver.
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

state=$(state_file inbound-http-request)
read -r did_id request_id decision_id < "$state"
api_delete "/dids/$did_id"
api_delete "/httpRequests/$request_id"
api_delete "/decisions/$decision_id"
stop_http_receiver
rm -f "$state"
