#!/usr/bin/env bash
# §10.1 step 7 "HTTP requests": DID +15551095 goes to the HTTP request `crm`, a GET to the HTTP
# receiver with the caller's number in its query. Its target is a decision whose one case, a
# `template` condition on the answer's tier, sends the call to the CI group's mailbox; the
# decision's default and the request's error target end the call unanswered, so only a call
# routed on the answer leaves a message. Starts the receiver, and records what the teardown
# removes.
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

start_http_receiver
group_id=$(ci_group)
# The request first, since the decision's template reads its answer by its name.
request_id=$(api POST /httpRequests "{
  \"name\": \"crm\",
  \"request\": { \"url\": \"$HTTP_RECEIVER/lookup?caller={{callerNumber}}\" },
  \"target\": { \"kind\": \"hangup\" },
  \"errorTarget\": { \"kind\": \"hangup\" }
}" | jsonfield id)
decision_id=$(api POST /decisions "{
  \"name\": \"ci-tier\",
  \"cases\": [{
    \"when\": [{ \"type\": \"template\", \"template\": \"{{crm.data.tier}}\", \"equals\": \"vip\" }],
    \"target\": { \"kind\": \"mailboxRingGroup\", \"ringGroupId\": \"$group_id\" }
  }],
  \"default\": { \"kind\": \"hangup\" }
}" | jsonfield id)
api PATCH "/httpRequests/$request_id" \
  "{\"target\":{\"kind\":\"decision\",\"decisionId\":\"$decision_id\"}}" >/dev/null
did_id=$(api POST /dids \
  "{\"number\":\"+15551095\",\"target\":{\"kind\":\"httpRequest\",\"httpRequestId\":\"$request_id\"}}" \
  | jsonfield id)
printf '%s %s %s\n' "$did_id" "$request_id" "$decision_id" > "$(state_file inbound-http-request)"
