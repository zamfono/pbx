#!/usr/bin/env bash
# §10.2 "Sample rate": the trunk leg runs G.711 A-law but the answering phone G.722 (`answer-g722`),
# and one wideband leg of the bridge is enough: the member's recording is 16 kHz.
set -euo pipefail

bash "$(dirname "$0")/_recording-check.sh" "$1" "$2" "$3" 16000
