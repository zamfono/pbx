#!/usr/bin/env bash
# Removes what `_voice-bot-setup.sh` created for an `inbound-forward-web-socket*` scenario: the
# DID, and the bot.
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

state=$(state_file inbound-forward-web-socket)
api_delete "/dids/$(cat "$state")"
dc exec -T sip-tls sh -c \
  'kill "$(cat /tmp/voice-bot.pid)"; rm -rf /tmp/voice-bot /tmp/voice-bot.log /tmp/voice-bot.pid'
rm -f "$state" "$(state_file recording-before)"
