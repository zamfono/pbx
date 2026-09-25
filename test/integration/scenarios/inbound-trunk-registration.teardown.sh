#!/usr/bin/env bash
# Stops the provider's registrar and removes the trunk and DID `inbound-trunk-registration.setup.sh`
# created.
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

read -r trunk_id did_id < "$(state_file registration)"
api_delete "/dids/$did_id"
api_delete "/trunks/$trunk_id"
# shellcheck disable=SC2086 -- `$compose` carries the runtime's own multi-word command
$compose exec -T sipp-provider sh -c 'pkill sipp || true'
rm -f "$(state_file registration)"
