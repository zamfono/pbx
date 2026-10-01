#!/usr/bin/env bash
# Undoes `inbound-api-deposit.setup.sh`'s scenario state.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

rm -f "$(state_file api-deposit)" "$(state_file api-deposit-before)" \
  "$(state_file api-deposit.log)"
