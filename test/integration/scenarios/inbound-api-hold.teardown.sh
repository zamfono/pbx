#!/usr/bin/env bash
# Undoes the setup: the hold music and its log (`inbound-hold.teardown.sh`), and the background
# call control's state (`_api-control-teardown.sh`).
set -euo pipefail

here=$(dirname "$0")
bash "$here/inbound-hold.teardown.sh" "$@"
bash "$here/_api-control-teardown.sh" "$1" "$2"
