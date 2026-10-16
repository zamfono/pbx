#!/usr/bin/env bash
# §9.4 "WebSocket targets", a Vonage bot at 24 kHz (`_voice-bot-setup.sh`).
set -euo pipefail

bash "$(dirname "$0")/_voice-bot-setup.sh" "$1" "$2" "$3" vonage 24000
