#!/usr/bin/env bash
# §9.4 "Inbound identification", "Inbound numbers": the call came from the `ip` trunk's own
# address, so it is that trunk's, recorded in the routing trace; its E.164 numbers pass the
# `e164` boundary unchanged and the called number matched the main DID.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

trunk_id=$(api GET /trunks | python3 -c "
import json, sys
print([t['id'] for t in json.load(sys.stdin)['items'] if t['name'] == 'ci-trunk'][0])
")
did_id=$(api GET /dids | python3 -c "
import json, sys
print([d['id'] for d in json.load(sys.stdin)['items'] if d['number'] == '+15551000'][0])
")
newest_call | python3 "$(dirname "$0")/_inbound-trunk-check.py" \
  "$trunk_id" "$did_id" +15551000 +15559999
