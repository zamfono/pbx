#!/usr/bin/env bash
# §10.2 "Recording semantics": the answering user's participation, ended by the trunk hanging up,
# is one playable recording. Both legs run G.711 A-law (the trunk offers PCMA alone and the phone
# answers `answer-speak`'s PCMA), so it is recorded at 8 kHz ("Sample rate"). At level `qos`
# (the setup) the call also leaves a `call_qos` row for each leg it bridged (`_qos-check.sh`),
# each with its jitter and loss measured: both sides spoke, so both legs received RTP.
set -euo pipefail

bash "$(dirname "$0")/_recording-check.sh" "$1" "$2" "$3" 8000
bash "$(dirname "$0")/_qos-check.sh" "$1" "$2" measured
