#!/usr/bin/env bash
# §10.2 "Effective flag": the DID's user records its calls and forwards unconditionally to a `sip` target
# (`_recording-forward-setup.sh`).
set -euo pipefail

bash "$(dirname "$0")/_recording-forward-setup.sh" "$1" "$2" "$3" true sip
