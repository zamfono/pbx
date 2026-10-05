# Sourced by `run.sh`, which calls `run_sip_ban_step` when `sip-ban` is selected (`only.sh`):
# §5.6 SIP brute-force banning, played through the real stack by a scanner on the `outside`
# network (compose.test.yaml's `sipp-outside`), since `core` exempts every address of `internal`
# as the stack's own. With the thresholds lowered, its failed REGISTERs ban it: `api` holds the
# ban, `/metrics` and `/healthz` show it, and nftables drops its next request while HTTP still
# answers. `sipBans.lift` lets it through again; an allowlist entry covering it keeps it from
# being banned; once that entry is gone its next ban takes the second, permanent step; and an
# empty step list lifts enforcement.
# Reads `run.sh`'s own compose, RUNTIME, api_base, METRICS_TOKEN and fail, and api.sh's helpers.
# Self-contained: it connects `asterisk` to `outside` for its own run and disconnects it again,
# lifts the bans it caused and restores the settings it changed, so REUSE may select it freely.

SIP_BAN_ADDRESS=10.213.48.20
SIP_BAN_TARGET=10.213.48.10
SIP_BAN_FAILURES=3
SIP_BAN_ATTEMPTS=20
SIP_BAN_POLLS=30

# One failed attempt from the scanner (`uas/register-unknown.xml`); fails when Asterisk does not
# answer it.
sip_ban_attempt() {
  dc exec -T sipp-outside sh -c "sipp -sf /scenarios/uas/register-unknown.xml \
    -key user scanner -au scanner -ap guessed -m 1 -timeout 5s -timeout_error -nostdin \
    $SIP_BAN_TARGET:5060 >>/tmp/sip-ban.log 2>&1" </dev/null
}

# Whether Asterisk answers the scanner at all (`uas/register-challenge.xml`), no failed attempt.
sip_ban_answered() {
  dc exec -T sipp-outside sh -c "sipp -sf /scenarios/uas/register-challenge.xml \
    -key user scanner -m 1 -timeout 3s -timeout_error -nostdin \
    $SIP_BAN_TARGET:5060 >>/tmp/sip-ban.log 2>&1" </dev/null
}

# Whether Caddy, in Asterisk's network namespace, answers the scanner's HTTP request on port 80
# (§5.6: the ban drops SIP alone); any status line will do.
sip_ban_http_answered() {
  dc exec -T sipp-outside bash -c "exec 3<>/dev/tcp/$SIP_BAN_TARGET/80 \
    && printf 'GET /healthz HTTP/1.0\r\n\r\n' >&3 && head -1 <&3" </dev/null | grep -q '^HTTP/'
}

sip_ban_dropped() {
  ! sip_ban_answered
}

# The scanner's active ban as `<id> <step> <expiresAt>`, nothing while it has none.
sip_ban_active() {
  api GET /sipBans | python3 -c '
import json, sys
for ban in json.load(sys.stdin)["items"]:
    if ban["address"] == sys.argv[1]:
        print(ban["id"], ban["step"], ban["expiresAt"])' "$SIP_BAN_ADDRESS"
}

sip_ban_has_active() {
  [ -n "$(sip_ban_active)" ]
}

# Fails attempts until the scanner holds an active ban, at most SIP_BAN_ATTEMPTS of them.
sip_ban_fail_until_banned() {
  for ((attempt = 1; attempt <= SIP_BAN_ATTEMPTS; attempt++)); do
    sip_ban_attempt || fail "Asterisk did not answer the scanner's attempt $attempt"
    sip_ban_has_active && return 0
  done
  fail "$SIP_BAN_ATTEMPTS failed attempts did not ban the scanner"
}

sip_ban_lift() {
  api_delete "/sipBans/$1"
}

sip_ban_metric() {
  curl -fsS "${FWD[@]}" -H "Authorization: Bearer $METRICS_TOKEN" "$api_base/metrics" \
    | awk '$1 == "zamfono_sip_bans_active" { print $2 }'
}

# The `outside` network's name and `asterisk`'s container, for the runtime's `network` command.
sip_ban_network() {
  local id
  id=$(dc ps -q sipp-outside)
  "$RUNTIME" inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}' "$id"
}

run_sip_ban_step() {
  echo '== §5.6 failed SIP attempts ban their source, nftables drops it =='
  local network asterisk settings id step expires allow attempt
  network=$(sip_ban_network) || fail "could not find sipp-outside's network"
  asterisk=$(dc ps -q asterisk)
  "$RUNTIME" network connect --ip "$SIP_BAN_TARGET" "$network" "$asterisk" \
    || fail "could not connect asterisk to $network"
  settings=$(api GET /settings | python3 -c '
import json, sys
s = json.load(sys.stdin)
print(json.dumps({k: s[k] for k in ("sipBanFailures", "sipBanWindowS", "sipBanSuccessExemptS", "sipBanSteps")}))')
  api PATCH /settings "{\"sipBanFailures\":$SIP_BAN_FAILURES,\"sipBanWindowS\":600,
    \"sipBanSuccessExemptS\":0,\"sipBanSteps\":[86400,null]}" >/dev/null
  sip_ban_answered || fail 'Asterisk does not answer the scanner before any failure'

  sip_ban_fail_until_banned
  read -r id step expires <<<"$(sip_ban_active)"
  [ "$step" = 1 ] && [ "$expires" != None ] \
    || fail "the first ban is step $step, expiring $expires, not step 1 for a day"
  reads 1 sip_ban_metric || fail "zamfono_sip_bans_active reads '$last_read', not 1"
  reads pass healthz_check sipBan:helper || fail '/healthz reports the ban helper stopped'
  poll $SIP_BAN_POLLS 1 sip_ban_dropped || fail "the banned scanner's REGISTER is still answered"
  sip_ban_http_answered || fail "the banned scanner's HTTP request is not answered"
  echo '   banned at step 1: its SIP is dropped, HTTP answers'

  sip_ban_lift "$id"
  poll $SIP_BAN_POLLS 1 sip_ban_answered || fail 'the lifted scanner is still dropped'
  echo '   sipBans.lift: answered again'

  allow=$(api POST /sipAllowlist '{"address":"10.213.48.0/24","label":"sip-ban"}' | jsonfield id)
  for ((attempt = 1; attempt <= 2 * SIP_BAN_FAILURES; attempt++)); do
    sip_ban_attempt || fail "Asterisk did not answer the allowlisted scanner's attempt $attempt"
  done
  sip_ban_answered || fail 'the allowlisted scanner is dropped'
  ! sip_ban_has_active || fail 'the allowlisted scanner was banned'
  api_delete "/sipAllowlist/$allow"
  echo '   allowlisted: never banned'

  sip_ban_fail_until_banned
  read -r id step expires <<<"$(sip_ban_active)"
  [ "$step" = 2 ] && [ "$expires" = None ] \
    || fail "the next ban is step $step, expiring $expires, not the permanent step 2"
  poll $SIP_BAN_POLLS 1 sip_ban_dropped || fail "the permanently banned scanner is still answered"
  echo '   banned again within the lookback: the permanent step 2'

  api PATCH /settings '{"sipBanSteps":[]}' >/dev/null
  reads '' dc exec -T asterisk cat /etc/asterisk/gen/sip_bans.list \
    || fail "with no steps the ban list still reads '$last_read'"
  poll $SIP_BAN_POLLS 1 sip_ban_answered || fail 'with no steps the scanner is still dropped'
  echo '   no steps: enforcement off, the scanner is answered'

  # Its ban's row stays active while banning is off; lifted, nothing is enforced once the
  # settings are back.
  sip_ban_lift "$id"
  api PATCH /settings "$settings" >/dev/null
  sip_ban_answered || fail 'the scanner is dropped once the settings are restored'
  "$RUNTIME" network disconnect "$network" "$asterisk" \
    || fail "could not disconnect asterisk from $network"
}
