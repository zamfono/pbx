# Sourced by the scenarios' setup, check and teardown scripts: the REST calls they make
# (test/api.sh) and the tenant state they share. Reads `api_base` and `token`, and `compose` where
# a script drives a container.

# shellcheck source=../../api.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../api.sh"

# The id of the live user holding extension `$1`.
user_with_ext() {
  api GET /users | python3 -c "
import json, sys
print([u['id'] for u in json.load(sys.stdin)['items'] if u['extension'] == sys.argv[1]][0])
" "$1"
}

# A container's address on the stack's network.
container_ip() {
  # shellcheck disable=SC2086 # `$compose` carries the runtime's own multi-word command
  $compose exec -T "$1" hostname -i | tr -d '\r' | awk '{print $1}'
}

# Waits up to 10 s for UDP port `$2` in container `$1` to be bound: the sipp run started there
# detached is up and answers on it.
await_bound() {
  local port
  port=$(printf ':%04X' "$2")
  for _ in $(seq 1 20); do
    # shellcheck disable=SC2086 # `$compose` carries the runtime's own multi-word command
    if $compose exec -T "$1" awk -v port="$port" \
      'substr($2, length($2) - 4) == port { found = 1 } END { exit !found }' /proc/net/udp; then
      return 0
    fi
    sleep 0.5
  done
  echo "nothing bound UDP port $2 in $1 within 10 s" >&2
  return 1
}

# The status `pjsip show contacts` gives the contact of AOR `$1`, a device's SIP username or a
# trunk's `trunk-<id>`: `NonQual` until its first qualify result lands, then `Avail` or `Unavail`;
# nothing while it has none. The listing truncates a contact to `<aor>/<uri>`; the AOR is matched
# whole, so `101` is not `1011`.
contact_status() {
  local listing
  # Read whole before awk sees it: under pipefail, Podman's compose provider reports the CLI's
  # SIGPIPE as a failure.
  # shellcheck disable=SC2086 # `$compose` carries the runtime's own multi-word command
  listing=$($compose exec -T asterisk asterisk -rx 'pjsip show contacts')
  printf '%s\n' "$listing" \
    | awk -v aor="$1/" '$1 == "Contact:" && index($2, aor) == 1 { print $4 }'
}

# Waits up to 20 s for the contact of AOR `$1` to read a status matching the extended regex `$2`,
# and prints it.
await_contact_status() {
  local status=''
  for _ in $(seq 1 40); do
    status=$(contact_status "$1")
    if [[ $status =~ ^($2)$ ]]; then
      printf '%s\n' "$status"
      return 0
    fi
    sleep 0.5
  done
  echo "the contact of $1 reads '${status:-none}', not $2, after 20 s" >&2
  return 1
}

# Probes the contact of AOR `$1` once and waits for it to read reachable, `Avail`, or a status
# matching `$2` (`Avail|NonQual` for a trunk whose qualify may be off). Whatever answers the probe
# must be up already (`await_bound`): a probe it does not answer times out, and that result,
# applied whenever it lands, would mark the contact unreachable after a later probe's answer.
await_contact_avail() {
  # shellcheck disable=SC2086 # `$compose` carries the runtime's own multi-word command
  $compose exec -T asterisk asterisk -rx "pjsip qualify $1" >/dev/null
  await_contact_status "$1" "${2:-Avail}" >/dev/null
}

# Waits up to 20 s for the core to report every `ip` trunk `registered`, its qualify answered, or
# `unmonitored`, its qualify off (§9.4 "Provisioning and status"): the status a call's route
# fallthrough reads, which follows Asterisk's contact status by an event.
await_ip_trunks_reachable() {
  local unready
  for _ in $(seq 1 40); do
    unready=$(api GET /trunks | python3 -c '
import json, sys
print(" ".join("%s:%s" % (t["name"], t["status"]) for t in json.load(sys.stdin)["items"]
               if t["authMode"] == "ip" and t["status"] not in ("registered", "unmonitored")))
')
    [ -n "$unready" ] || return 0
    sleep 0.5
  done
  echo "ip trunks the core does not report reachable after 20 s: $unready" >&2
  return 1
}

# Waits up to `$3` seconds for the sipp run tagged `$2` in container `$1` (`_sipp-run.sh`) to
# end, which it says by writing its exit status.
await_sipp_run() {
  local attempt
  for attempt in $(seq 1 "$3"); do
    # shellcheck disable=SC2086 # `$compose` carries the runtime's own multi-word command
    if $compose exec -T "$1" test -f "/tmp/sipp-runs/$2.exit"; then
      return 0
    fi
    sleep 1
  done
  echo "the sipp run $2 in $1 did not end within $attempt s" >&2
  return 1
}

# The ring group every trunk scenario's DID points at: the one `configure.sh` created.
ci_group() {
  api GET /ringGroups | python3 -c "
import json, sys
print([g['id'] for g in json.load(sys.stdin)['items'] if g['name'] == 'ci-group'][0])
"
}

# Points DID `$1` at ring group `$2`, printing the DID's id.
did_to_group() {
  api POST /dids "{\"number\":\"$1\",\"target\":{\"kind\":\"ringGroup\",\"ringGroupId\":\"$2\"}}" \
    | jsonfield id
}

# The newest call in the history, with its routing trace: the one the scenario just placed.
newest_call() {
  api GET "/calls/$(api GET /calls | jsonfield items.0.id)"
}

# Scenario state a setup leaves for its check and teardown, under one file per scenario, in the
# run's own directory (run.sh's `STATE_DIR`).
state_file() {
  mkdir -p "${STATE_DIR:?set by run.sh}"
  printf '%s/%s\n' "$STATE_DIR" "$1"
}

# The id of the live trunk named `$1`.
trunk_named() {
  api GET /trunks | python3 -c "
import json, sys
print([t['id'] for t in json.load(sys.stdin)['items'] if t['name'] == sys.argv[1]][0])
" "$1"
}

# Live trunk `$1` as `GET /trunks` lists it, without the live status the core merges in (§9.4
# "Provisioning and status"): what a teardown compares to the setup's copy to show it left the
# trunk as it found it.
trunk_snapshot() {
  api GET /trunks | python3 -c "
import json, sys
trunk = [t for t in json.load(sys.stdin)['items'] if t['id'] == sys.argv[1]][0]
trunk.pop('status', None)
trunk.pop('statusChangedAt', None)
print(json.dumps(trunk, sort_keys=True))
" "$1"
}

# The outbound routes as `PUT /outboundRoutes` takes them back, in evaluation order: a setup saves
# them, and its teardown puts them back as they were.
routes_body() {
  api GET /outboundRoutes | python3 -c '
import json, sys
routes = json.load(sys.stdin)["items"]
for route in routes:
    route.pop("priority", None)
print(json.dumps(routes))
'
}

# Puts one route per `<number>=<trunk-id>` argument ahead of `$1`, a list `routes_body` printed,
# each carrying that one number for every caller (§9.4 "Outbound routing").
put_routes_ahead() {
  local saved=$1
  shift
  api PUT /outboundRoutes "$(python3 -c '
import json, sys
ahead = [
    {"trunkId": trunk, "users": [], "userGroups": [], "numbers": [{"number": number}]}
    for number, trunk in (arg.split("=", 1) for arg in sys.argv[2:])
]
print(json.dumps({"routes": ahead + json.loads(sys.argv[1])}))
' "$saved" "$@")" >/dev/null
}

# Puts back the routes `routes_body` printed as `$1`.
put_routes() {
  api PUT /outboundRoutes "{\"routes\": $1}" >/dev/null
}

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
device = json.load(sys.stdin)
print(device['sipUsername'], device['sipPassword'])
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

# Waits up to `$2` seconds for call `$1` to reach the history, which lists a call once it has
# ended, and prints it with its trace.
await_ended_call() {
  local attempt
  for attempt in $(seq 1 "$2"); do
    if api GET "/calls/$1" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "call $1 never ended within $attempt s" >&2
  return 1
}

# Prints sipp message trace `$2` in container `$1` once it holds at least `$3` received INVITEs
# and has stopped growing: sipp writes it as the messages go, and a check that reads it the moment
# the call ended can find the INVITE not yet written. After 15 s it prints what is there, and the
# check reports what is missing.
await_trace() {
  local attempt content previous='' count
  for attempt in $(seq 1 15); do
    # shellcheck disable=SC2086 # `$compose` carries the runtime's own multi-word command
    content=$($compose exec -T "$1" cat "$2" 2>/dev/null || true)
    count=$(printf '%s\n' "$content" | grep -c '^INVITE ' || true)
    if [ "$count" -ge "$3" ] && [ "$content" = "$previous" ]; then
      printf '%s\n' "$content"
      return 0
    fi
    previous=$content
    sleep 1
  done
  echo "$2 in $1 held $count of $3 INVITEs after $attempt s" >&2
  printf '%s\n' "$content"
}

# Waits up to 30 s for a call in progress in state `$1` (`ringing`, or `up` once answered and
# bridged) and prints its id: call `$2` itself, else one a ring group routed; with `$3`, only one
# that user's phone rings or is in. The call a scenario's background API action acts on, as a
# CRM's button acts on the call it shows (`_api-control.sh`).
await_live_call() {
  local id
  for _ in $(seq 1 150); do
    id=$(api GET '/calls?live=true' | python3 -c '
import json, sys
state, wanted, user = sys.argv[1:4]
for call in json.load(sys.stdin)["items"]:
    if call["state"] != state:
        continue
    if wanted and call["callId"] != wanted:
        continue
    if not wanted and not call["ringGroupId"]:
        continue
    if user and user not in call["userIds"]:
        continue
    print(call["callId"])
    break
' "$1" "${2:-}" "${3:-}")
    if [ -n "$id" ]; then
      printf '%s\n' "$id"
      return 0
    fi
    sleep 0.2
  done
  echo "no live call in state $1 within 30 s" >&2
  return 1
}
