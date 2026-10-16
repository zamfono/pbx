#!/usr/bin/env bash
# §9.4 "WebSocket targets", a Vonage bot at the default rate, 16 kHz (`_voice-bot-check.sh`).
set -euo pipefail

bash "$(dirname "$0")/_voice-bot-check.sh" "$1" "$2" "$3" vonage 16000
