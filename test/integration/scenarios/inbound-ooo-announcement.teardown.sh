#!/usr/bin/env bash
# Removes the rule and the asset `inbound-ooo-announcement.setup.sh` created, so the scenarios
# after it ring as usual.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

read -r rule_id audio_id < "$(state_file ooo-announcement)"
api_delete "/ooo/$rule_id"
api_delete "/audio/$audio_id"
rm -f "$(state_file ooo-announcement)"
