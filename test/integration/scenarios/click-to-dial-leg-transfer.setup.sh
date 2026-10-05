#!/usr/bin/env bash
# §10.3 "Live calls", §10.1 "Transfers and pickup": a colleague, 102, whose phone answers, speaks
# and hangs up (`answer-speak-hangup`), and the transfer started in the background, waiting for
# 101's outbound call to +15557502 to be bridged (`_api-control.sh leg-transfer`): the harness's
# admin, who is in no call, names the far end's leg, which moves on to 102, 101 released.
set -euo pipefail

bash "$(dirname "$0")/_api-control-setup.sh" "$1" "$2" "$3" leg-transfer \
  answer-speak-hangup +15557502,callee,102
