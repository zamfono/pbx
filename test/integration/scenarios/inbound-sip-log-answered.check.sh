#!/usr/bin/env bash
# §7 level `sip`: the answered call's log holds both of its legs' SIP messages, each in its
# direction: the trunk's INVITE in, Asterisk's 100 and 200 out; the INVITE out to the phone and
# the phone's 200 in; the trunk's BYE in and Asterisk's BYE out to the phone.
set -euo pipefail

bash "$(dirname "$0")/_sip-log-check.sh" "$1" "$2" inbound-sip-log-answered +15551000 \
  'in ^INVITE ' 'out ^SIP/2\.0 100 ' 'out ^SIP/2\.0 200 ' \
  'out ^INVITE ' 'in ^SIP/2\.0 200 ' \
  'in ^BYE ' 'out ^BYE '
