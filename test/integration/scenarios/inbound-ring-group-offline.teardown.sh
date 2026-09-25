#!/usr/bin/env bash
# Registers 101's device again and removes the group, DID and user
# `inbound-ring-group-offline.setup.sh` created.
set -euo pipefail

api_base=$1
token=$2
compose=$3
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

read -r _ absent_id group_id did_id sip_username sip_password < "$(state_file offline)"
bash "$here/../phone.sh" "$compose" register "$sip_username" "$sip_password" >/dev/null
api_delete "/dids/$did_id"
api_delete "/ringGroups/$group_id"
api_delete "/users/$absent_id"
rm -f "$(state_file offline)"
