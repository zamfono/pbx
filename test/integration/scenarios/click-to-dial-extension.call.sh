#!/usr/bin/env bash
# §10.2 "Click-to-dial": `POST /calls` rings 101's phone, which answers and hangs up a few seconds
# later (`answer-speak-hangup`); in between the stack dials extension 102 as that phone would
# have, and the colleague's phone answers.
set -euo pipefail

bash "$(dirname "$0")/_originate.sh" "$1" "$2" 102
