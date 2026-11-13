#!/usr/bin/env bash
# §10.1 step 7 "Fallback and ring timeout": a DID of its own whose target is a voice bot the core
# never connects to, `localhost`, whose loopback addresses are refused as it connects (§3.1
# "Outbound targets"; a loopback literal is refused when the target is written), with an external
# number as its fallback.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

api POST /dids \
  '{"number":"+15551013","target":{"kind":"webSocket","protocol":"twilio","url":"ws://localhost:9/","fallback":{"kind":"external","external":"+15557777","ringTimeoutS":30}}}' \
  | jsonfield id > "$(state_file forward-fallback)"
