#!/usr/bin/env bash
# §10.2 "Click-to-dial": `POST /calls` rings 101's phone, which answers, and the stack dials
# +15557502 out over the trunk, which answers; the transfer then moves the far end on to 102, and
# 102's phone hangs up. Returns once the onward call has ended too.
set -euo pipefail

api_base=$1
token=$2
here=$(dirname "$0")
# shellcheck source=_lib.sh
. "$here/_lib.sh"

bash "$here/_originate.sh" "$api_base" "$token" +15557502
parent=$(cat "$(state_file originated)")
poll 30 1 onward_ended "$parent" || { echo "the onward call of $parent never ended" >&2; exit 1; }
