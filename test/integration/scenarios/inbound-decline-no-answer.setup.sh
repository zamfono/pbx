#!/usr/bin/env bash
# §10.1 step 4, a 603 decline: the DID `+15551005` targets user 101 directly, and 101's mailbox
# is switched off for the scenario, so an unanswered ring ends in the implicit defaults, 480 for
# `noAnswer` and 486 for `busy`, rather than both in the mailbox. Records what the teardown
# restores.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

member_id=$(user_with_ext 101)
# A DID that targets a user becomes their presented number when they have none (§9.4
# "Caller-ID"), so the teardown puts back the one 101 presents now.
caller_id=$(api GET /users | python3 -c "
import json, sys
print(json.dumps([u for u in json.load(sys.stdin)['items'] if u['id'] == sys.argv[1]][0]['calleridDidId']))
" "$member_id")
api PATCH "/users/$member_id" '{"mailboxEnabled":false}' >/dev/null
did_id=$(api POST /dids \
  "{\"number\":\"+15551005\",\"target\":{\"kind\":\"user\",\"userId\":\"$member_id\"}}" \
  | jsonfield id)
printf '%s %s %s\n' "$member_id" "$did_id" "$caller_id" > "$(state_file decline)"
