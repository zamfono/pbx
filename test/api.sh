# shellcheck shell=bash
# Sourced by the integration and load harnesses: how their scripts reach the REST API (§10.3) and
# the stack's containers. Reads `api_base` (`http://127.0.0.1:<port>`, or `https://<FQDN>` through
# Caddy) and `token`, and `compose` for `dc`, `container_ip` and `asterisk_cli`.
#
# The api runs behind Caddy, which sets `X-Forwarded-For`; adapter-node is configured to require
# it (`ADDRESS_HEADER`), so a request the harness sends the api directly carries it, as the
# proxy's would. Caddy itself trusts no client's, and sets its own in its place.
FWD=(-H 'X-Forwarded-For: 127.0.0.1')

# `dc <args>` runs Compose on the stack: `compose` is the whole command as one string, the
# runtime's own multi-word command and the stack's project and files included, the form a child
# script is handed it in.
dc() {
  # shellcheck disable=SC2086 # `compose` is split into its words by design
  $compose "$@"
}

# A container's address on the stack's network.
# `exec` hands the container its standard input, so it reads none here: a caller may expand this
# in the arguments of a pipeline's reader, whose input it would otherwise take.
container_ip() {
  dc exec -T "$1" hostname -i </dev/null | tr -d '\r' | awk '{print $1}'
}

# `asterisk_cli <command>` runs one Asterisk CLI command in `asterisk`, printing its output.
asterisk_cli() {
  dc exec -T asterisk asterisk -rx "$1"
}

# `poll <tries> <interval_s> <cmd…>` runs the command until it succeeds, at most `tries` times,
# `interval_s` apart, and fails when it never did; the caller says what never happened. The
# command runs in this shell, so a variable it sets is the caller's to read.
poll() {
  local tries=$1 interval=$2 try
  shift 2
  for ((try = 1; ; try++)); do
    "$@" && return 0
    [ "$try" -lt "$tries" ] || return 1
    sleep "$interval"
  done
}

# `reads <value> <cmd…>` succeeds when the command succeeds and prints exactly `value`; what it
# printed is left in `last_read`, for the caller's failure message.
reads() {
  last_read=$("${@:2}") && [ "$last_read" = "$1" ]
}

# `api <method> <path> [<json-body>]` prints the response body, and fails on a status other than
# 2xx.
api() {
  local args=(-fsS -X "$1" "$api_base/api/v1$2" "${FWD[@]}" -H "Authorization: Bearer $token")
  [ $# -lt 3 ] || args+=(-H 'Content-Type: application/json' -d "$3")
  curl "${args[@]}"
}

# The same, for a caller that asserts the status itself: prints the status, then the body on a
# line of its own.
api_status() {
  local args=(-sS -X "$1" "$api_base/api/v1$2" "${FWD[@]}" -H "Authorization: Bearer $token"
    -w '\n%{http_code}')
  [ $# -lt 3 ] || args+=(-H 'Content-Type: application/json' -d "$3")
  local response
  response=$(curl "${args[@]}") || return 1
  printf '%s\n%s\n' "${response##*$'\n'}" "${response%$'\n'*}"
}

# `api_all <path>` prints every item of list `<path>` as one `{"items": [...]}`, read page by page
# at the most a page holds (§10.3: `limit` at most 200, `nextCursor` to the next page).
api_all() {
  local sep='?' cursor='' page pages=()
  [[ $1 != *'?'* ]] || sep='&'
  while :; do
    page=$(api GET "$1${sep}limit=200${cursor:+&cursor=$cursor}") || return 1
    pages+=("$page")
    cursor=$(printf '%s' "$page" | jsonfield nextCursor) || return 1
    [ "$cursor" != None ] || break
  done
  printf '%s\n' "${pages[@]}" | python3 -c '
import json, sys
print(json.dumps({"items": [item for page in sys.stdin for item in json.loads(page)["items"]]}))
'
}

# A delete asks for confirmation (§10.3), which the REST body gives as `confirm`.
api_delete() {
  api DELETE "$1" '{"confirm":true}' >/dev/null
}

# The status of `/healthz`'s check `$1` (`pass`, `warn` or `fail`); a 503 carries the document too.
healthz_check() {
  curl -sS "${FWD[@]}" "$api_base/healthz" | jsonfield "checks.$1.0.status"
}

# `/healthz`'s HTTP status: 200 for `pass` and `warn`, 503 for `fail` (§6.3 "Health").
healthz_http_status() {
  curl -sS -o /dev/null -w '%{http_code}' "${FWD[@]}" "$api_base/healthz"
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
