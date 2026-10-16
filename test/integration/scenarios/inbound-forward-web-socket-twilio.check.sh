#!/usr/bin/env bash
# §9.4 "WebSocket targets", a Twilio Media Streams bot, μ-law at 8 kHz (`_voice-bot-check.sh`).
set -euo pipefail

bash "$(dirname "$0")/_voice-bot-check.sh" "$1" "$2" "$3" twilio 8000
