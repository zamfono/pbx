#!/usr/bin/env bash
# §10.2 "Click-to-dial" with `clir: true`: `POST /calls` rings 101's phone, which answers and
# hangs up a few seconds later (`answer-speak-hangup`); in between the stack dials `+15557102`
# as that phone would have dialled `#31#+15557102`, over `ci-clir`, whose side answers.
set -euo pipefail

bash "$(dirname "$0")/_originate.sh" "$1" "$2" +15557102 60 '"clir": true'
