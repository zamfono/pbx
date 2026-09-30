#!/usr/bin/env bash
# Shared check of the `*-sip-log-*` scenarios (§7 level `sip`): `_sip-log-check.py` against the
# newest call. A call at this level closes a few seconds after it ends, so its `log` is written
# only then; the check is retried until it passes or the call has had ample time to close.
#   _sip-log-check.sh API TOKEN TO '<direction> <first-line regex>'...
set -euo pipefail

api_base=$1
token=$2
shift 2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

ATTEMPTS=20
for attempt in $(seq 1 $ATTEMPTS); do
  if report=$(newest_call | python3 "$(dirname "$0")/_sip-log-check.py" "$@" 2>&1); then
    exit 0
  fi
  [ "$attempt" = $ATTEMPTS ] || sleep 1
done
echo "$report" >&2
exit 1
