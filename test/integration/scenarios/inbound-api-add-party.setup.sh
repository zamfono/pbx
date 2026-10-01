#!/usr/bin/env bash
# §10.2 "Three-way calls" over the API: the colleague added, 102, answers, speaks and hangs up a
# few seconds later (`answer-speak-hangup`); the added party is asked for in the background
# (`_api-control.sh add-party`).
set -euo pipefail

bash "$(dirname "$0")/_api-control-setup.sh" "$1" "$2" "$4" add-party answer-speak-hangup
