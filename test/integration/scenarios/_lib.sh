# Sourced by the scenarios' setup, check and teardown scripts: the REST calls they make, as the
# harness's own `configure.sh` makes them. Reads `api_base` and `token`, and `compose` where a
# script drives a container.

api() {
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -fsS -X "$method" "$api_base/api/v1$path" -H 'X-Forwarded-For: 127.0.0.1' \
      -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "$body"
  else
    curl -fsS -X "$method" "$api_base/api/v1$path" -H 'X-Forwarded-For: 127.0.0.1' \
      -H "Authorization: Bearer $token"
  fi
}

# A delete asks for confirmation (§10.3), which the REST body gives as `confirm`.
api_delete() {
  api DELETE "$1" '{"confirm":true}' >/dev/null
}

# One field out of a JSON object on stdin, by a dotted path (`user.id`, `items.0.id`).
jsonfield() {
  python3 -c '
import json, sys
value = json.load(sys.stdin)
for step in sys.argv[1].split("."):
    value = value[int(step)] if step.isdigit() else value[step]
print(value)
' "$1"
}

# The id of the live user holding extension `$1`.
user_with_ext() {
  api GET /users | python3 -c "
import json, sys
print([u['id'] for u in json.load(sys.stdin)['items'] if u['extension'] == sys.argv[1]][0])
" "$1"
}

# A container's address on the stack's network.
container_ip() {
  # shellcheck disable=SC2086 -- `$compose` carries the runtime's own multi-word command
  $compose exec -T "$1" hostname -i | tr -d '\r' | awk '{print $1}'
}

# Waits until Asterisk's configuration holds PJSIP endpoint `$1`: an endpoint reaches it through
# a config render and a PJSIP reload after the write that created it, and a request that arrives
# before that is answered as from no endpoint at all.
await_endpoint() {
  local attempt
  for attempt in $(seq 1 30); do
    # The listing names the endpoint as `<name>/<caller-ID number>` once it has a `callerid`.
    # shellcheck disable=SC2086 -- `$compose` carries the runtime's own multi-word command
    if $compose exec -T asterisk asterisk -rx "pjsip show endpoint $1" 2>/dev/null \
      | grep "Endpoint:  *$1[ /]" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "endpoint $1 never reached Asterisk after $attempt attempts" >&2
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

# Scenario state a setup leaves for its check and teardown, under one file per scenario.
state_file() {
  printf '/tmp/zamfono-%s\n' "$1"
}

# The id of the live trunk named `$1`.
trunk_named() {
  api GET /trunks | python3 -c "
import json, sys
print([t['id'] for t in json.load(sys.stdin)['items'] if t['name'] == sys.argv[1]][0])
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
