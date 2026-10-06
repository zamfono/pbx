#!/usr/bin/env bash
# §10.2 "Effective flag": the answered trunk leg of a DID's own recording `sip` target is
# recorded as nobody's participation: one playable recording, at 8 kHz since both legs run G.711
# A-law, its row naming no user.
set -euo pipefail

bash "$(dirname "$0")/_recording-check.sh" "$1" "$2" "$3" 8000 -
