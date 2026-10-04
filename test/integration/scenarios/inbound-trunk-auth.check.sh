#!/usr/bin/env bash
# §9.4 "Inbound identification", "Inbound number normalization": the call the digest credential
# identified is the inbound-auth trunk's, its called `+15551002` matched the DID `+15551002`, and
# its caller `+15559998` reached the history as `+15559998`.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

read -r trunk_id did_id < "$(state_file auth)"
newest_call | python3 "$(dirname "$0")/_inbound-trunk-check.py" \
  "$trunk_id" "$did_id" +15551002 +15559998
