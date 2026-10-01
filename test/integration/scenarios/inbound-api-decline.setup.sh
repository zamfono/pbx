#!/usr/bin/env bash
# §10.1 step 5 with a decline over the API: the harness's own owner, whose token declines, becomes
# the ring group's first member, with a phone of their own beside 101's that rings without
# answering (`ring-no-answer`), on the colleague's port (`_lib.sh`). The group rings sequentially
# with a 20 s turn per member, so only a decline moves it on to 101 in time; what the group was
# before is kept for the teardown. The owner gets extension 109 for the device, kept afterwards,
# since an extension is never taken away again. The decline itself waits in the background
# (`_api-control.sh decline`).
set -euo pipefail

api_base=$1
token=$2
compose=$4
here=$(dirname "$0")
# shellcheck source=_lib.sh
. "$here/_lib.sh"

owner_id=$(api GET /users | python3 -c '
import json, sys
print([u["id"] for u in json.load(sys.stdin)["items"] if u["role"] == "owner"][0])
')
if [ "$(api GET "/users/$owner_id" | jsonfield extension)" = None ]; then
  api PATCH "/users/$owner_id" '{"extension": "109"}' >/dev/null
fi
member_id=$(user_with_ext 101)
allowed=$(api GET "/users/$member_id/devices" | python3 -c "
import json, sys
print(json.dumps(json.load(sys.stdin)['items'][0]['allowedIps']))
")
read -r device_id sip_username sip_password < <(api POST "/users/$owner_id/devices" \
  "{\"kind\":\"manual\",\"label\":\"ci-decliner\",\"transport\":\"plain\",\"allowedIps\":$allowed}" \
  | python3 -c "
import json, sys
device = json.load(sys.stdin)
print(device['device']['id'], device['sipUsername'], device['sipPassword'])
")
printf '%s\n' "$device_id" > "$(state_file api-decline-device)"
printf '%s %s %s\n' "$owner_id" "$sip_username" "$sip_password" > "$(state_file decliner)"
await_endpoint "$sip_username"
PHONE_PORT=$COLLEAGUE_PORT bash "$here/../phone.sh" "$compose" \
  register "$sip_username" "$sip_password" >&2
serve_colleague ring-no-answer decliner

group_id=$(ci_group)
api GET "/ringGroups/$group_id" > "$(state_file api-decline-group)"
api PATCH "/ringGroups/$group_id" "{
  \"strategy\": \"sequential\",
  \"ringTimeoutS\": 20,
  \"members\": [{\"kind\": \"user\", \"id\": \"$owner_id\"}, {\"kind\": \"user\", \"id\": \"$member_id\"}]
}" >/dev/null

bash "$here/_api-control-setup.sh" "$api_base" "$token" "$compose" decline '' "$owner_id"
