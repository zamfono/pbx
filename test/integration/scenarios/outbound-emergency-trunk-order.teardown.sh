#!/usr/bin/env bash
# Removes the three trunks `outbound-emergency-trunk-order.setup.sh` created, puts the trunk order
# back, and checks that `ci-trunk` reads as it did before the setup, its flag and its priority
# included. The second provider's three sides have already ended with the scenario
# (`run-scenarios.sh`'s `finish_sipp_runs`).
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

read -r refuse_id plain_id answer_id ci_id < "$(state_file emergency-order)"
for id in "$refuse_id" "$plain_id" "$answer_id"; do
  api_delete "/trunks/$id"
done
api PUT /trunks/order "{\"trunkIds\": $(cat "$(state_file emergency-order-saved)")}" >/dev/null

ci_after=$(trunk_snapshot "$ci_id")
ci_before=$(cat "$(state_file emergency-order-ci)")
rm -f "$(state_file emergency-order)" "$(state_file emergency-order-saved)" \
  "$(state_file emergency-order-ci)"
if [ "$ci_after" != "$ci_before" ]; then
  echo "ci-trunk was left changed: before $ci_before, after $ci_after" >&2
  exit 1
fi
