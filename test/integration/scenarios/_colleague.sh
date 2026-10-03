# Sourced by the scenarios that add a colleague of 101's, a second user with a phone of their own:
# `_lib.sh`'s helpers, and the colleague's creation, phone and removal.

# shellcheck source=_lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

# A colleague's phone beside 101's in the `sipp-phone` container, on a port of its own
# (`phone.sh`'s `PHONE_PORT`): the target a click-to-dial rings, or the picker's phone of an API
# pickup.
COLLEAGUE_PORT=5072

# Creates user `$1` (email `$2`, extension `$3`) with a device on the phone container's subnet,
# the answering device's own allowlist. Leaves `<user-id> <sip-username> <sip-password>` in the
# scenario state `$4`.
add_colleague() {
  local name=$1 email=$2 ext=$3 state=$4 member_id allowed user_id sip_username sip_password
  member_id=$(user_with_ext 101)
  allowed=$(api GET "/users/$member_id/devices" | python3 -c "
import json, sys
print(json.dumps(json.load(sys.stdin)['items'][0]['allowedIps']))
")
  user_id=$(api POST /users "{\"name\":\"$name\",\"email\":\"$email\",\"extension\":\"$ext\"}" \
    | jsonfield user.id)
  read -r sip_username sip_password < <(api POST "/users/$user_id/devices" \
    "{\"kind\":\"manual\",\"label\":\"ci-colleague\",\"transport\":\"plain\",\"allowedIps\":$allowed}" \
    | python3 -c "
import json, sys
settings = json.load(sys.stdin)['connectionSettings']
print(settings['username'], settings['password'])
")
  printf '%s %s %s\n' "$user_id" "$sip_username" "$sip_password" > "$(state_file "$state")"
}

# Registers the colleague of scenario state `$2` from the colleague's port, serves them with
# phone scenario `$1` (`uas/<name>.xml`) and waits until their device is reachable, as
# `phone.sh answer` serves 101's. Their device's contact goes with the device, which the
# teardown deletes.
serve_colleague() {
  local uas=$1 user_id sip_username sip_password
  read -r user_id sip_username sip_password < "$(state_file "$2")"
  PHONE_PORT=$COLLEAGUE_PORT bash "$(dirname "${BASH_SOURCE[0]}")/../phone.sh" "$compose" \
    answer "$uas" "$sip_username" "$sip_password" >&2
}

# The user id of the colleague of scenario state `$1`.
colleague_id() {
  local user_id _rest
  read -r user_id _rest < "$(state_file "$1")"
  printf '%s\n' "$user_id"
}

# Deletes the colleague of scenario state `$1`, and with them their device.
remove_colleague() {
  api_delete "/users/$(colleague_id "$1")"
  rm -f "$(state_file "$1")"
}
