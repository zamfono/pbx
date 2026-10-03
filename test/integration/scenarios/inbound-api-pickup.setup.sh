#!/usr/bin/env bash
# §10.1 "Pickup" over the API: the colleague's phone answers the ring the pickup starts on it and
# hangs up a few seconds into the call it took (`answer-speak-hangup`).
set -euo pipefail

bash "$(dirname "$0")/_api-pickup-setup.sh" "$@" answer-speak-hangup
