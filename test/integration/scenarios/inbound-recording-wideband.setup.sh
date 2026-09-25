#!/usr/bin/env bash
# §10.2 "Sample rate": the same recording member as `inbound-recording-trunk-hangup`, whose setup
# this is.
set -euo pipefail

bash "$(dirname "$0")/inbound-recording-trunk-hangup.setup.sh" "$@"
