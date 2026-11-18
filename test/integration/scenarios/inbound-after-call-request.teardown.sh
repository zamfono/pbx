#!/usr/bin/env bash
# Undoes `inbound-after-call-request.setup.sh`: the recording forward, and the receiver.
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

bash "$(dirname "$0")/_recording-forward-teardown.sh" "$1" "$2" "$3"
stop_http_receiver
