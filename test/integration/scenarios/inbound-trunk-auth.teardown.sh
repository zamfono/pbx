#!/usr/bin/env bash
# Removes the trunk and DID `inbound-trunk-auth.setup.sh` created.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

read -r trunk_id did_id < "$(state_file auth)"
api_delete "/dids/$did_id"
api_delete "/trunks/$trunk_id"
rm -f "$(state_file auth)"
