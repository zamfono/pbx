#!/usr/bin/env bash
# The setup the `inbound-forward-web-socket*` scenarios share (§9.4 "WebSocket targets"): DID
# +15551090 hands its calls to a recording `webSocket` target of protocol `$4` at sample rate `$5`
# (left out of the target when empty, so the protocol's default), the bot `_voice-bot.cjs`
# speaking the same, run in the `sip-tls` container from the api image, whose `ws` it uses.
# Leaves the DID's id for the teardown, and the newest call before the scenario's own for the
# check.
#
# Usage: _voice-bot-setup.sh <api-base> <token> <compose> <vonage|twilio> [<rate>]
set -euo pipefail

api_base=$1
token=$2
compose=$3
protocol=$4
rate=${5:-}
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

dc exec -T sip-tls rm -rf /tmp/voice-bot
dc exec -T -d -e "PROTOCOL=$protocol" -e "RATE=$rate" sip-tls sh -c \
  'NODE_PATH=/app/node_modules node /scenarios/_voice-bot.cjs > /tmp/voice-bot.log 2>&1'
poll 30 1 dc exec -T sip-tls test -e /tmp/voice-bot/listening \
  || { echo "the voice bot never listened" >&2; exit 1; }

target="{\"kind\":\"webSocket\",\"protocol\":\"$protocol\",\"url\":\"ws://sip-tls:8765/calls?token=ci\",${rate:+\"sampleRate\":$rate,}\"record\":true}"
api POST /dids "{\"number\":\"+15551090\",\"target\":$target}" | jsonfield id \
  > "$(state_file inbound-forward-web-socket)"
newest_call_id > "$(state_file recording-before)"
