#!/usr/bin/env bash
# Puts the routes back and removes the second provider's trunk `outbound-fallthrough.setup.sh`
# created; that provider's side has already ended with the scenario (`run-scenarios.sh`'s
# `finish_sipp_runs`).
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

put_routes "$(cat "$(state_file fallthrough-routes)")"
api_delete "/trunks/$(cat "$(state_file fallthrough)")"
rm -f "$(state_file fallthrough)" "$(state_file fallthrough-routes)"
