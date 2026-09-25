#!/usr/bin/env bash
# §5.6: the request that claimed the trunk by its From user was never a call: the history's newest
# entry is still the one before it.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

before=$(cat "$(state_file spoof)")
after=$(api GET /calls | jsonfield items.0.id)
[ "$after" = "$before" ] || {
  echo "a request claiming trunk-<id> by its From user became call $after" >&2
  exit 1
}
