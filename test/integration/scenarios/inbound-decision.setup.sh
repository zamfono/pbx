#!/usr/bin/env bash
# §10.1 step 7 "Decisions": the main DID's target becomes a decision with one case, a caller
# number prefix the sipp caller (+15559999) has, to the CI group's mailbox, and the group itself as
# its default, so a caller the case did not match would ring the phone. Records the DID's and the
# decision's ids for the teardown.
set -euo pipefail

api_base=$1
token=$2

# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

group_id=$(ci_group)
did_id=$(api GET /dids | jsonfield items.0.id)

decision_id=$(api POST /decisions "{
  \"name\": \"ci-decision\",
  \"cases\": [{
    \"when\": [
      { \"type\": \"caller\", \"number\": \"+1555\", \"isPrefix\": true },
      { \"type\": \"not\", \"condition\": { \"type\": \"callerUser\" } }
    ],
    \"target\": { \"kind\": \"mailboxRingGroup\", \"ringGroupId\": \"$group_id\" }
  }],
  \"default\": { \"kind\": \"ringGroup\", \"ringGroupId\": \"$group_id\" }
}" | jsonfield id)

api PATCH "/dids/$did_id" \
  "{\"target\":{\"kind\":\"decision\",\"decisionId\":\"$decision_id\"}}" >/dev/null

printf '%s %s\n' "$did_id" "$decision_id" > "$(state_file decision)"
