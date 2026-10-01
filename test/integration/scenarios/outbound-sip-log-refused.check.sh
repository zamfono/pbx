#!/usr/bin/env bash
# §7 level `sip`: the refused trunk leg's dialog is in the call's log, though the leg lasted
# milliseconds: the INVITE out, the trunk's 403 in and the ACK out, besides the device's INVITE in.
set -euo pipefail

bash "$(dirname "$0")/_sip-log-check.sh" "$1" "$2" outbound-sip-log-refused +15557501 \
  'in ^INVITE ' 'out ^INVITE ' 'in ^SIP/2\.0 403 ' 'out ^ACK '
