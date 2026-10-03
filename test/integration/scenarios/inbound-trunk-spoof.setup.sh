#!/usr/bin/env bash
# §5.6, §9.4 "Inbound identification": hands the caller's run the `ip` trunk's endpoint name as
# its injection file, and notes the newest call in the history, which a request identified as the
# trunk would push down.
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

printf 'SEQUENTIAL\ntrunk-%s;\n' "$(trunk_named ci-trunk)" \
  | dc exec -T sipp-phone sh -c 'cat > /tmp/spoof.csv'
api GET /calls | jsonfield items.0.id > "$(state_file spoof)"
