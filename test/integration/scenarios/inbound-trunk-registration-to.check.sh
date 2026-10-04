#!/usr/bin/env bash
# §9.4 "Inbound number normalization": the registration trunk's call, addressed to its account
# name, was routed by the number in `To`, `0012125551077`, which the trunk's `national` format
# reads as `+12125551077`; its national caller `0301111` reached the history as `+49301111`.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

read -r trunk_id did_id < "$(state_file registration-to)"
newest_call | python3 "$(dirname "$0")/_inbound-trunk-check.py" \
  "$trunk_id" "$did_id" +12125551077 +49301111
