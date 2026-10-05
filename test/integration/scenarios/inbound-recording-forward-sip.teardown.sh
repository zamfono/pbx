#!/usr/bin/env bash
# Undoes `inbound-recording-forward-sip.setup.sh`.
set -euo pipefail

bash "$(dirname "$0")/_recording-forward-teardown.sh" "$1" "$2" "$3"
