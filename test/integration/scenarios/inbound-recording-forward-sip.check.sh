#!/usr/bin/env bash
# §10.2 "Effective flag": the answered trunk leg of 181's unconditional forward to a SIP target
# is 181's participation, recorded under 181's own flag: one playable recording, at 8 kHz since
# both legs run G.711 A-law, its row naming 181.
set -euo pipefail

bash "$(dirname "$0")/_recording-check.sh" "$1" "$2" "$3" 8000 181
