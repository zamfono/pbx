#!/usr/bin/env bash
# One access token for the owner, through the flow a real client uses (§5.2): register a client,
# run the authorization-code grant with PKCE against the login page, approve the consent step,
# redeem the code.
#
# Usage: bootstrap-token.sh [--remote] <base> <email> <password> [origin]
#
# Each step of the login page is a remote `form`. By default the harness submits it as a browser
# without JavaScript does, a POST of the page itself. `--remote` submits it as the page's own
# script does, a POST to the form's endpoint under `/_app/remote/`, which SvelteKit accepts only
# from the origin it derives for the request itself, `origin` here: the same POST from a foreign
# origin is sent first, and must be refused with 403.
set -euo pipefail

remote=false
if [ "${1:-}" = --remote ]; then
  remote=true
  shift
fi
api=$1
email=$2
password=$3
origin=${4:-}
# shellcheck source=../api.sh
. "$(dirname "$0")/../api.sh"

# SvelteKit negotiates a page POST's response from `Accept`, and answers JSON for a request that
# accepts anything. The login page's steps are browser-served (§5.2), so these requests ask for
# HTML the way a browser does, and carry the `Origin` a browser sends with a form POST: the page
# refuses a submission from any other origin. The client endpoints (`/oauth/register`,
# `/oauth/token`) are called the way a non-browser client calls them, without one.
PAGE=(-H 'Accept: text/html')
if [ -n "$origin" ]; then
  PAGE+=(-H "Origin: $origin")
fi

# `zamfono_consent` is set by the login step and read by the consent step, so the two requests
# share a jar the way a browser does.
jar=$(mktemp)
trap 'rm -f "$jar"' EXIT
COOKIES=(-c "$jar" -b "$jar")

form_submission() {
  # The page's own form as a browser submits it: its `action` on the first line, then the body,
  # each hidden field with its rendered value and each `<base name>=<value>` argument filled into
  # the field of that name (a submit button only when its value matches). Each step of §5.2's
  # login page is a remote `form`, whose action and field names carry a build-time id, so the
  # harness reads them off the rendered page rather than hard-coding them.
  python3 -c "
import html, re, sys, urllib.parse
page = sys.stdin.read()
action = re.search(r'<form[^>]*\baction=\"([^\"]+)\"', page)
wanted = dict(arg.split('=', 1) for arg in sys.argv[1:])
fields = []
for tag in re.findall(r'<(?:input|button)\b[^>]*>', page):
    attrs = {k: html.unescape(v) for k, v in re.findall(r'([\w-]+)=\"([^\"]*)\"', tag)}
    name = attrs.get('name')
    if name is None:
        continue
    base = name.split('/', 1)[0]
    is_choice = attrs.get('type') == 'submit'
    if base in wanted and (not is_choice or attrs.get('value') == wanted[base]):
        fields.append((name, wanted.pop(base)))
    elif attrs.get('type') == 'hidden':
        fields.append((name, attrs.get('value', '')))
print(html.unescape(action.group(1)) if action else '')
print(urllib.parse.urlencode(fields))
" "$@"
}

# `form_submission`'s body in the encoding the page's script sends a remote form in
# (`application/x-sveltekit-formdata`): a version byte, the header's length (u32) and the file
# table's length (u16, no files here), then the header, devalue's flattened form of `[data,
# meta]`, each field under its name without the form id.
binary_form() {
  python3 -c "
import json, struct, sys, urllib.parse
values = [[1, 2], {}, {'remote_refreshes': 3}, []]
for name, value in urllib.parse.parse_qsl(sys.stdin.read(), keep_blank_values=True):
    values[1][name.split('/', 1)[0]] = len(values)
    values.append(value)
header = json.dumps(values).encode()
sys.stdout.buffer.write(struct.pack('<BIH', 0, len(header), 0) + header)
"
}

# `form_submission`'s form `$1` posted to its remote endpoint from origin `$2`, with the page's
# own path and query in the headers the script sends them in; the arguments after those are
# curl's. The form's action names both the query and the form: `?<query>&/remote=<id>`.
remote_post() {
  local action=${1%%$'\n'*} body=${1#*$'\n'} from=$2 search
  search=${action%%/remote=*}
  shift 2
  printf '%s' "$body" | binary_form | curl -sS -X POST "$api/_app/remote/${action#*/remote=}" \
    "${FWD[@]}" "${COOKIES[@]}" -H "Origin: $from" \
    -H 'Content-Type: application/x-sveltekit-formdata' \
    -H 'x-sveltekit-pathname: /oauth/authorize' -H "x-sveltekit-search: ${search%&}" \
    --data-binary @- "$@"
}

# S256 verifier/challenge (RFC 7636): base64url of the SHA-256 of the verifier, unpadded.
verifier=$(openssl rand -hex 32)
challenge=$(printf '%s' "$verifier" \
  | openssl dgst -binary -sha256 \
  | openssl base64 \
  | tr '+/' '-_' \
  | tr -d '=\n')

redirect_uri='http://127.0.0.1:0/callback'
client_id=$(curl -fsS -X POST "$api/oauth/register" "${FWD[@]}" \
  -H 'Content-Type: application/json' \
  -d "{\"client_name\":\"ci\",\"redirect_uris\":[\"$redirect_uri\"],\"application_type\":\"native\"}" \
  | jsonfield client_id)
[ -n "$client_id" ] || { echo 'registration returned no client_id' >&2; exit 1; }

authorize_page() {
  curl -fsS "${FWD[@]}" "${PAGE[@]}" "${COOKIES[@]}" --get \
    --data-urlencode "client_id=$client_id" \
    --data-urlencode "redirect_uri=$redirect_uri" \
    --data-urlencode 'state=ci' \
    --data-urlencode 'response_type=code' \
    --data-urlencode "code_challenge=$challenge" \
    --data-urlencode 'code_challenge_method=S256' \
    --data-urlencode 'scope=openid' \
    "$api/oauth/authorize"
}

login=$(authorize_page | form_submission "email=$email" "_password=$password" 'action=password')
login_action=${login%%$'\n'*}
[ -n "$login_action" ] || { echo 'the login page rendered no form' >&2; exit 1; }

# The login step answers the consent page and seals `zamfono_consent`; no code is minted until
# the consent step is approved (§5.2 "Authentication pages"). Submitted by the page's script, it
# answers the form's result instead, and the page, reloaded, renders the consent step from the
# cookie.
if [ "$remote" = true ]; then
  refused=$(remote_post "$login" 'https://foreign.invalid' -o /dev/null -w '%{http_code}')
  [ "$refused" = 403 ] || {
    echo "the login form's remote POST from a foreign origin answered $refused, not 403" >&2
    exit 1
  }
  result=$(remote_post "$login" "$origin" -f)
  [[ $result == *needsConsent* ]] \
    || { echo "the login form's result is no consent step: $result" >&2; exit 1; }
  consent=$(authorize_page | form_submission 'action=approve')
else
  consent=$(curl -fsS -X POST "$api/oauth/authorize$login_action" "${FWD[@]}" \
    "${PAGE[@]}" "${COOKIES[@]}" --data "${login#*$'\n'}" \
    | form_submission 'action=approve')
fi
consent_action=${consent%%$'\n'*}
[ -n "$consent_action" ] || { echo 'the login step rendered no consent form' >&2; exit 1; }

# Approving redirects to the redirect URI with the code: a page POST answers 302, which
# `--max-redirs 0` keeps curl from chasing to a loopback address nothing is listening on; a remote
# one answers the redirect in its result, devalue-encoded like every remote result.
if [ "$remote" = true ]; then
  location=$(remote_post "$consent" "$origin" -f | python3 -c '
import json, sys
values = json.loads(json.load(sys.stdin)["data"])
print(values[values[0]["redirect"]])
')
else
  location=$(curl -sS -o /dev/null -D - -X POST "$api/oauth/authorize$consent_action" \
    "${FWD[@]}" "${PAGE[@]}" "${COOKIES[@]}" \
    --max-redirs 0 \
    --data "${consent#*$'\n'}" \
    | awk 'tolower($1) == "location:" { print $2 }' | tr -d '\r')
fi
code=$(printf '%s' "$location" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')
[ -n "$code" ] || { echo "no authorization code in: $location" >&2; exit 1; }

curl -fsS -X POST "$api/oauth/token" "${FWD[@]}" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=authorization_code' \
  --data-urlencode "code=$code" \
  --data-urlencode "code_verifier=$verifier" \
  --data-urlencode "client_id=$client_id" \
  --data-urlencode "redirect_uri=$redirect_uri" \
  | jsonfield access_token
