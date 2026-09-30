#!/usr/bin/env bash
# Puts back the level `outbound-sip-log-answered.setup.sh` raised.
set -euo pipefail

bash "$(dirname "$0")/_sip-log-teardown.sh" "$1" "$2" outbound-sip-log-answered
