#!/usr/bin/env bash
# Puts the routes back, removes the second provider's trunk `outbound-fallthrough.setup.sh`
# created and stops that provider's side.
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

put_routes "$(cat "$(state_file fallthrough-routes)")"
api_delete "/trunks/$(cat "$(state_file fallthrough)")"
# shellcheck disable=SC2086 -- `$compose` carries the runtime's own multi-word command
$compose exec -T sipp-provider sh -c 'pkill sipp || true'
rm -f "$(state_file fallthrough)" "$(state_file fallthrough-routes)"
