#!/usr/bin/env bash
# §10.2 "Click-to-dial" to an extension: a colleague, 102, with a phone of their own beside 101's
# (`_lib.sh`'s `add_colleague`), which answers the call the stack places once 101's phone has
# answered (`answer`) and stays on until 101 hangs up.
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

add_colleague 'CI Colleague' colleague@ci.test 102 colleague
serve_colleague answer colleague
