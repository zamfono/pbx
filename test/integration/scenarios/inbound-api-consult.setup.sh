#!/usr/bin/env bash
# §10.1 "Transfers and pickup" over the API, attended: the colleague consulted, 102, answers the
# consultation and hangs up a few seconds into the call it was transferred
# (`answer-speak-hangup`); the consultation and the transfer run in the background
# (`_api-control.sh consult`).
set -euo pipefail

bash "$(dirname "$0")/_api-control-setup.sh" "$@" consult answer-speak-hangup
