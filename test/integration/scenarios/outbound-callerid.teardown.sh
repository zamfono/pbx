#!/usr/bin/env bash
# Puts the routes back and removes the two trunks `outbound-callerid.setup.sh` created.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

put_routes "$(cat "$(state_file callerid-routes)")"
read -r pai_id both_id < "$(state_file callerid)"
api_delete "/trunks/$pai_id"
api_delete "/trunks/$both_id"
rm -f "$(state_file callerid)" "$(state_file callerid-routes)"
