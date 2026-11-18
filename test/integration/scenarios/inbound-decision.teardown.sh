#!/usr/bin/env bash
# Points the main DID back at the CI group and removes the decision `inbound-decision.setup.sh`
# created, so the scenarios after it ring as usual.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

read -r did_id decision_id < "$(state_file decision)"
api PATCH "/dids/$did_id" \
  "{\"target\":{\"kind\":\"ringGroup\",\"ringGroupId\":\"$(ci_group)\"}}" >/dev/null
api_delete "/decisions/$decision_id"
rm -f "$(state_file decision)"
