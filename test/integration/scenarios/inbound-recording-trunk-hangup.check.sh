#!/usr/bin/env bash
# §10.2 "Recording semantics": the answering user's participation, ended by the trunk hanging up,
# is one playable recording. Both legs run G.711 A-law (the trunk offers PCMA alone and the phone
# answers `answer-speak`'s PCMA), so it is recorded at 8 kHz ("Sample rate").
set -euo pipefail

bash "$(dirname "$0")/_recording-check.sh" "$1" "$2" "$3" 8000
