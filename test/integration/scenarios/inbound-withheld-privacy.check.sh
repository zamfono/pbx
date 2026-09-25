#!/usr/bin/env bash
# §9.4 "Withheld caller": the caller's `From` held `+15559999`, but `Privacy: id` suppressed that
# identity, so the call carries `anonymous` as its caller; otherwise it is the plain inbound call
# of the `ip` trunk, answered through the ring group.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

did_id=$(api GET /dids | python3 -c "
import json, sys
print([d['id'] for d in json.load(sys.stdin)['items'] if d['number'] == '+15551000'][0])
")
newest_call | python3 "$(dirname "$0")/_inbound-trunk-check.py" \
  "$(trunk_named ci-trunk)" "$did_id" +15551000 anonymous
