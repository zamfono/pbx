#!/usr/bin/env bash
# §8 "pickup": a second user, 102, with a device of their own on the phone container's subnet.
# While the ring group rings 101, 102 dials `*8101` (§9.3) from the phone side. Prints that
# device's SIP username and password, the account the phone side places the pickup from, and
# records the user's id for the check and the teardown. The picker's device never registers, so
# nothing else waits for its endpoint to reach Asterisk before the pickup is dialled from it.
set -euo pipefail

api_base=$1
token=$2
compose=$4
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

# The answering device's allowlist, so 102's device is admitted from the same container.
member_id=$(user_with_ext 101)
allowed=$(api GET "/users/$member_id/devices" | python3 -c "
import json, sys
print(json.dumps(json.load(sys.stdin)['items'][0]['allowedIps']))
")

picker_id=$(api POST /users '{"name":"CI Picker","email":"picker@ci.test","extension":"102"}' \
  | jsonfield user.id)
printf '%s\n' "$picker_id" > /tmp/zamfono-picker-user

read -r sip_username sip_password < <(api POST "/users/$picker_id/devices" \
  "{\"kind\":\"manual\",\"label\":\"ci-picker\",\"transport\":\"plain\",\"allowedIps\":$allowed}" \
  | python3 -c "
import json, sys
device = json.load(sys.stdin)
print(device['sipUsername'], device['sipPassword'])
")
await_endpoint "$sip_username"
printf '%s %s\n' "$sip_username" "$sip_password"
