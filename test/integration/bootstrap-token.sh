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

form_action() {
  # The `action` of the page's own form. Each step of §5.2's login page is a remote `form`, whose
  # action carries a build-time id, so the harness reads it off the rendered page as a browser
  # does rather than hard-coding it.
  python3 -c "
import re, sys
match = re.search(r'<form[^>]*\baction=\"([^\"]+)\"', sys.stdin.read())
print(match.group(1) if match else '')
"
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

login_action=$(curl -fsS "${FWD[@]}" "${PAGE[@]}" "${COOKIES[@]}" --get \
  --data-urlencode "client_id=$client_id" \
  --data-urlencode "redirect_uri=$redirect_uri" \
  --data-urlencode 'state=ci' \
  --data-urlencode 'response_type=code' \
  --data-urlencode "code_challenge=$challenge" \
  --data-urlencode 'code_challenge_method=S256' \
  --data-urlencode 'scope=openid' \
  "$api/oauth/authorize" | form_action)
[ -n "$login_action" ] || { echo 'the login page rendered no form' >&2; exit 1; }

# The login step answers the consent page and seals `zamfono_consent`; no code is minted until
# the consent step is approved (§5.2 "Authentication pages").
consent_action=$(curl -fsS -X POST "$api/oauth/authorize$login_action" "${FWD[@]}" \
  "${PAGE[@]}" "${COOKIES[@]}" \
  --data-urlencode "email=$email" \
  --data-urlencode "_password=$password" \
  --data-urlencode 'action=password' \
  --data-urlencode "client_id=$client_id" \
  --data-urlencode "redirect_uri=$redirect_uri" \
  --data-urlencode 'state=ci' \
  --data-urlencode 'response_type=code' \
  --data-urlencode "code_challenge=$challenge" \
  --data-urlencode 'code_challenge_method=S256' \
  --data-urlencode 'scope=openid' \
  | form_action)
[ -n "$consent_action" ] || { echo 'the login step rendered no consent form' >&2; exit 1; }

# Approving answers 302 to the redirect URI with the code; `--max-redirs 0` keeps curl from
# chasing a loopback address nothing is listening on.
location=$(curl -sS -o /dev/null -D - -X POST "$api/oauth/authorize$consent_action" \
  "${FWD[@]}" "${PAGE[@]}" "${COOKIES[@]}" \
  --max-redirs 0 \
  --data-urlencode 'action=approve' \
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
