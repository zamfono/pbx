#!/usr/bin/env bash
# §7 level `sip`: a call refused at once still records its INVITE in, the 404 out and the ACK in.
set -euo pipefail

bash "$(dirname "$0")/_sip-log-check.sh" "$1" "$2" inbound-sip-log-refused +15550404 \
  'in ^INVITE ' 'out ^SIP/2\.0 404 ' 'in ^ACK '
