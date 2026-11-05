#!/usr/bin/env bash
# Removes the DID `inbound-forward-fallback.setup.sh` created.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

api_delete "/dids/$(cat "$(state_file forward-fallback)")"
rm -f "$(state_file forward-fallback)"
