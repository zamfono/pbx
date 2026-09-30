#!/usr/bin/env bash
# §10.2 "Click-to-dial": `POST /calls` rings 101's phone, which answers (`uas_for` plays
# `answer-speak-hangup`), and the stack then dials +15557501 out over the trunk as that phone
# would have; the trunk side answers and speaks (`answer-speak`), and 101 hangs up.
set -euo pipefail

bash "$(dirname "$0")/_originate.sh" "$1" "$2" +15557501
