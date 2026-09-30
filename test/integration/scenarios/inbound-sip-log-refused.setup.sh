#!/usr/bin/env bash
# §7 level `sip`: the tenant's level raised to `sip` for this call (`_sip-log-setup.sh`).
set -euo pipefail

bash "$(dirname "$0")/_sip-log-setup.sh" "$1" "$2" inbound-sip-log-refused
