#!/usr/bin/env bash
# One access token for the owner, through the flow a real client uses (§5.2): register a client,
# run the authorization-code grant with PKCE against the login page, approve the consent step,
# redeem the code.
#
# Usage: bootstrap-token.sh <api-base> <email> <password> [origin]
set -euo pipefail

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

login=$(curl -fsS "${FWD[@]}" "${PAGE[@]}" "${COOKIES[@]}" --get \
  --data-urlencode "client_id=$client_id" \
  --data-urlencode "redirect_uri=$redirect_uri" \
  --data-urlencode 'state=ci' \
  --data-urlencode 'response_type=code' \
  --data-urlencode "code_challenge=$challenge" \
  --data-urlencode 'code_challenge_method=S256' \
  --data-urlencode 'scope=openid' \
  "$api/oauth/authorize" \
  | form_submission "email=$email" "_password=$password" 'action=password')
login_action=${login%%$'\n'*}
[ -n "$login_action" ] || { echo 'the login page rendered no form' >&2; exit 1; }

# The login step answers the consent page and seals `zamfono_consent`; no code is minted until
# the consent step is approved (§5.2 "Authentication pages").
consent=$(curl -fsS -X POST "$api/oauth/authorize$login_action" "${FWD[@]}" \
  "${PAGE[@]}" "${COOKIES[@]}" --data "${login#*$'\n'}" \
  | form_submission 'action=approve')
consent_action=${consent%%$'\n'*}
[ -n "$consent_action" ] || { echo 'the login step rendered no consent form' >&2; exit 1; }

# Approving answers 302 to the redirect URI with the code; `--max-redirs 0` keeps curl from
# chasing a loopback address nothing is listening on.
location=$(curl -sS -o /dev/null -D - -X POST "$api/oauth/authorize$consent_action" \
  "${FWD[@]}" "${PAGE[@]}" "${COOKIES[@]}" \
  --max-redirs 0 \
  --data "${consent#*$'\n'}" \
  | awk 'tolower($1) == "location:" { print $2 }' | tr -d '\r')
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
