#!/usr/bin/env bash
# §10.1 "Pickup" over the API: the colleague's phone answered the ring the pickup started on it
# and took the call, whose row names the colleague as its answerer (`_api-pickup-check.sh`).
set -euo pipefail

bash "$(dirname "$0")/_api-pickup-check.sh" "$1" "$2" answered
