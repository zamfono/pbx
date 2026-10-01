#!/usr/bin/env bash
# §10.1 step 5 with a decline over the API: a user of the scenario's own, 102, becomes the ring
# group's first member, with a phone beside 101's that rings without answering
# (`ring-no-answer`). The group rings sequentially with a 20 s turn per member, so only a decline
# moves it on to 101 in time; what the group was before is kept for the teardown. A decline acts
# on the actor's own ringing legs (§10.3 "Live calls"), so the user sets a password through the
# link `POST /users/{id}/resetPassword` returns, as a new employee does (§5.2), and declines with
# a token of their own, in the background (`_api-control.sh decline`).
set -euo pipefail

api_base=$1
token=$2
compose=$4
here=$(dirname "$0")
# shellcheck source=_lib.sh
. "$here/_lib.sh"

DECLINER_EMAIL=decliner@ci.test
DECLINER_PASSWORD=decliner-secret

add_colleague 'CI Decliner' "$DECLINER_EMAIL" 102 decliner
decliner_id=$(colleague_id decliner)
link=$(api POST "/users/$decliner_id/resetPassword" '{}' | jsonfield link)
curl -fsS -X POST "$api_base/auth/reset" "${FWD[@]}" -H 'Content-Type: application/json' \
  -d "{\"token\":\"${link##*token=}\",\"password\":\"$DECLINER_PASSWORD\"}" >/dev/null
decliner_token=$(bash "$here/../bootstrap-token.sh" "$api_base" "$DECLINER_EMAIL" \
  "$DECLINER_PASSWORD" "${link%%/auth/*}")
serve_colleague ring-no-answer decliner

group_id=$(ci_group)
api GET "/ringGroups/$group_id" > "$(state_file api-decline-group)"
api PATCH "/ringGroups/$group_id" "{
  \"strategy\": \"sequential\",
  \"ringTimeoutS\": 20,
  \"members\": [{\"kind\": \"user\", \"id\": \"$decliner_id\"}, {\"kind\": \"user\", \"id\": \"$(user_with_ext 101)\"}]
}" >/dev/null

bash "$here/_api-control-setup.sh" "$api_base" "$decliner_token" "$compose" decline '' \
  "$decliner_id"
