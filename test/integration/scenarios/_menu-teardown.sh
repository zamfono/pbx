#!/usr/bin/env bash
# Removes the DID and menu `_menu-setup.sh` created under the state file `$3` names.
#
# Usage: _menu-teardown.sh <api-base> <token> <state-key>
set -euo pipefail

api_base=$1
token=$2
state_key=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

read -r menu_id did_id < "$(state_file "$state_key")"
api_delete "/dids/$did_id"
api_delete "/menus/$menu_id"
rm -f "$(state_file "$state_key")"
