#!/usr/bin/env bash
# §7 level `sip`: the outbound call's log holds the device's leg, its INVITE in, the 401 and the
# 200 out and its BYE in, and the trunk leg, the INVITE out, the trunk's 200 in and the BYE out.
set -euo pipefail

bash "$(dirname "$0")/_sip-log-check.sh" "$1" "$2" +15557401 \
  'in ^INVITE ' 'out ^SIP/2\.0 401 ' 'out ^SIP/2\.0 200 ' 'in ^BYE ' \
  'out ^INVITE ' 'in ^SIP/2\.0 200 ' 'out ^BYE '
