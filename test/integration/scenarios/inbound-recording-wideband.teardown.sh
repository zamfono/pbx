#!/usr/bin/env bash
# Undoes `inbound-recording-wideband.setup.sh`, as `inbound-recording-trunk-hangup`'s teardown.
set -euo pipefail

bash "$(dirname "$0")/inbound-recording-trunk-hangup.teardown.sh" "$@"
