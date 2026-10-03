#!/usr/bin/env bash
# §10.3 "Live calls", hold over the API: the tenant's hold music and the log the check reads it
# from, as for a softphone's hold (`inbound-hold.setup.sh`), and the hold and resume themselves
# in the background (`_api-control.sh hold`).
set -euo pipefail

here=$(dirname "$0")
bash "$here/inbound-hold.setup.sh" "$@"
bash "$here/_api-control-setup.sh" "$@" hold
