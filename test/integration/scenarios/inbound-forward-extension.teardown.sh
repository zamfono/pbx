#!/usr/bin/env bash
# Removes the DID `inbound-forward-extension.setup.sh` created, its target with it.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

state=$(state_file inbound-forward-extension)
api_delete "/dids/$(cat "$state")"
rm -f "$state"
