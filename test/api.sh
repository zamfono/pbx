# shellcheck shell=bash
# Sourced by the integration and load harnesses: how their scripts reach the REST API (§10.3).
# Reads `api_base` (`http://127.0.0.1:<port>`) and `token`.
#
# The api runs behind Caddy, which sets `X-Forwarded-For`; adapter-node is configured to require
# it (`ADDRESS_HEADER`), so a request the harness sends the api directly carries it, as the
# proxy's would.
FWD=(-H 'X-Forwarded-For: 127.0.0.1')

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
