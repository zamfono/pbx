#!/usr/bin/env bash
# Removes the group and DID `inbound-ring-group-skip-busy.setup.sh` created.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

read -r group_id did_id < "$(state_file skip-busy)"
api_delete "/dids/$did_id"
api_delete "/ringGroups/$group_id"
rm -f "$(state_file skip-busy)"
