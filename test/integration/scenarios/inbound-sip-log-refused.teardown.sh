#!/usr/bin/env bash
# Puts back the level `inbound-sip-log-refused.setup.sh` raised.
set -euo pipefail

bash "$(dirname "$0")/_sip-log-teardown.sh" "$1" "$2" inbound-sip-log-refused
