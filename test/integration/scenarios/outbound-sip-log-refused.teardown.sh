#!/usr/bin/env bash
# Puts back the level `outbound-sip-log-refused.setup.sh` raised.
set -euo pipefail

bash "$(dirname "$0")/_sip-log-teardown.sh" "$1" "$2" outbound-sip-log-refused
