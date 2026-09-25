#!/usr/bin/env bash
# §9.4 "Inbound identification", "Inbound number normalization": the call the `line` tag
# identified is the registration trunk's, its called party, the account name the trunk registered
# as its contact's user, matched the DID `ci-reg-acct` verbatim, and its national caller
# `0301111` reached the history as `+49301111`.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

read -r trunk_id did_id < "$(state_file registration)"
newest_call | python3 "$(dirname "$0")/_inbound-trunk-check.py" \
  "$trunk_id" "$did_id" ci-reg-acct +49301111
