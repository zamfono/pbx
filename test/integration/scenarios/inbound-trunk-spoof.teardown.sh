#!/usr/bin/env bash
# Forgets the newest call `inbound-trunk-spoof.setup.sh` noted.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

rm -f "$(state_file spoof)"
