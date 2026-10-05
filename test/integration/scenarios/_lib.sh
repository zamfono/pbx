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

# Waits up to 10 s for UDP port `$2` in container `$1` to be bound: the sipp run started there
# detached is up and answers on it.
await_bound() {
  local port
  port=$(printf ':%04X' "$2")
  poll 20 0.5 dc exec -T "$1" awk -v port="$port" \
    'substr($2, length($2) - 4) == port { found = 1 } END { exit !found }' /proc/net/udp \
    || { echo "nothing bound UDP port $2 in $1 within 10 s" >&2; return 1; }
}

# The status `pjsip show contacts` gives the contact of AOR `$1`, a device's SIP username or a
# trunk's `trunk-<id>`: `NonQual` until its first qualify result lands, then `Avail` or `Unavail`;
# nothing while it has none. The listing truncates a contact to `<aor>/<uri>`; the AOR is matched
# whole, so `101` is not `1011`.
contact_status() {
  local listing
  # Read whole before awk sees it: under pipefail, Podman's compose provider reports the CLI's
  # SIGPIPE as a failure.
  listing=$(asterisk_cli 'pjsip show contacts')
  printf '%s\n' "$listing" \
    | awk -v aor="$1/" '$1 == "Contact:" && index($2, aor) == 1 { print $4 }'
}

# Whether the contact of AOR `$1` reads a status matching the extended regex `$2`, left in
# `status`.
contact_matches() {
  status=$(contact_status "$1")
  [[ $status =~ ^($2)$ ]]
}

# Waits up to 20 s for the contact of AOR `$1` to read a status matching the extended regex `$2`,
# and prints it.
await_contact_status() {
  local status=''
  poll 40 0.5 contact_matches "$1" "$2" \
    || { echo "the contact of $1 reads '${status:-none}', not $2, after 20 s" >&2; return 1; }
  printf '%s\n' "$status"
}

# Probes the contact of AOR `$1` once and waits for it to read reachable, `Avail`, or a status
# matching `$2` (`Avail|NonQual` for a trunk whose qualify may be off). Whatever answers the probe
# must be up already (`await_bound`): a probe it does not answer times out, and that result,
# applied whenever it lands, would mark the contact unreachable after a later probe's answer.
await_contact_avail() {
  asterisk_cli "pjsip qualify $1" >/dev/null
  await_contact_status "$1" "${2:-Avail}" >/dev/null
}

# Waits up to 20 s for the core to report every `ip` trunk `registered`, its qualify answered, or
# `unmonitored`, its qualify off (§9.4 "Provisioning and status"): the status a call's route
# fallthrough reads, which follows Asterisk's contact status by an event.
await_ip_trunks_reachable() {
  poll 40 0.5 reads '' ip_trunks_unready \
    || { echo "ip trunks the core does not report reachable after 20 s: $last_read" >&2; return 1; }
}

# The `ip` trunks the core reports neither reachable nor unmonitored, as `<name>:<status>`.
ip_trunks_unready() {
  api GET /trunks | python3 -c '
import json, sys
print(" ".join("%s:%s" % (t["name"], t["status"]) for t in json.load(sys.stdin)["items"]
               if t["authMode"] == "ip" and t["status"] not in ("registered", "unmonitored")))
'
}

# Waits up to `$3` seconds for the sipp run tagged `$2` in container `$1` (`_sipp-run.sh`) to
# end, which it says by writing its exit status.
await_sipp_run() {
  poll "$3" 1 dc exec -T "$1" test -f "/tmp/sipp-runs/$2.exit" \
    || { echo "the sipp run $2 in $1 did not end within $3 s" >&2; return 1; }
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

# The status of trunk `$1` as `api` serves it from the core (§9.4 "Provisioning and status").
trunk_status() {
  api GET "/trunks/$1" | jsonfield status
}

# Waits up to `$3` seconds for trunk `$1` to read status `$2`.
await_trunk_status() {
  poll "$3" 1 reads "$2" trunk_status "$1" \
    || { echo "trunk $1 reads '${last_read:-none}', not $2, after $3 s" >&2; return 1; }
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

# Waits up to `$2` seconds for call `$1` to reach the history, which lists a call once it has
# ended, and prints it with its trace.
await_ended_call() {
  poll "$2" 1 api GET "/calls/$1" 2>/dev/null \
    || { echo "call $1 never ended within $2 s" >&2; return 1; }
}

# Whether the onward call of call `$1`, the one whose `parentCallId` it is, has reached the
# history, which lists a call once it has ended.
onward_ended() {
  api GET /calls | python3 -c '
import json, sys
sys.exit(not any(c["parentCallId"] == sys.argv[1] for c in json.load(sys.stdin)["items"]))
' "$1"
}

# Prints sipp message trace `$2` in container `$1`. The run that wrote it has ended, as every
# sipp run of a scenario has by the time its check runs (`run-scenarios.sh`'s
# `finish_sipp_runs`), so the trace is whole.
sipp_trace() {
  dc exec -T "$1" cat "$2"
}

# The id of the newest call in the history, empty while it holds none: what a setup notes before
# its scenario's call, for the check to tell that call by (`await_new_call`).
newest_call_id() {
  api GET /calls | python3 -c '
import json, sys
items = json.load(sys.stdin)["items"]
print(items[0]["id"] if items else "")
'
}

# Waits up to `$2` seconds for a call newer than call `$1` (`newest_call_id`) to reach the
# history, which lists a call once it has ended and its trace is written (§7), and prints its id.
await_new_call() {
  local id
  poll "$2" 1 newer_call "$1" \
    || { echo "no call newer than $1 reached the history within $2 s" >&2; return 1; }
  printf '%s\n' "$id"
}

# Whether the newest call in the history is another than call `$1`, left in `id`.
newer_call() {
  id=$(newest_call_id) && [ "$id" != "$1" ]
}

# Waits up to 30 s for a call in progress in state `$1` (`ringing`, or `up` once answered and
# bridged) and prints its id: call `$2` itself, else one a ring group routed; with `$3`, only one
# that user's phone rings or is in. The call a scenario's background API action acts on, as a
# CRM's button acts on the call it shows (`_api-control.sh`).
await_live_call() {
  local id
  poll 150 0.2 live_call "$@" || { echo "no live call in state $1 within 30 s" >&2; return 1; }
  printf '%s\n' "$id"
}

# The id of live call `$1`'s first leg of role `$2` (caller, callee, added), as `GET
# /calls?live=true` lists it (§10.3 "Live calls"); fails when it lists none.
live_leg() {
  local leg
  leg=$(api GET '/calls?live=true' | python3 -c '
import json, sys
call_id, role = sys.argv[1:3]
for call in json.load(sys.stdin)["items"]:
    if call["callId"] == call_id:
        print(next((leg["id"] for leg in call["legs"] if leg["role"] == role), ""))
' "$1" "$2") && [ -n "$leg" ] && printf '%s\n' "$leg"
}

# Whether a call `await_live_call` waits for is in progress, its id left in `id`.
live_call() {
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
' "$1" "${2:-}" "${3:-}") && [ -n "$id" ]
}
