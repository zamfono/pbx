#!/usr/bin/env bash
# Removes the trunk and DID `inbound-trunk-registration.setup.sh` created; the provider's registrar
# has already ended with the scenario (`run-scenarios.sh`'s `finish_sipp_runs`).
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

read -r trunk_id did_id < "$(state_file registration)"
api_delete "/dids/$did_id"
api_delete "/trunks/$trunk_id"
rm -f "$(state_file registration)"
