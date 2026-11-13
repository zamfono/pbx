# Sourced by `run.sh`, which calls `run_sip_ban_step` when `sip-ban` is selected (`only.sh`):
# §5.6 SIP brute-force banning, played through the real stack by a scanner on the `outside`
# network (compose.test.yaml's `sipp-outside`), since `core` exempts every address of `internal`
# as the stack's own. With the thresholds lowered, its failed REGISTERs ban it: `api` holds the
# ban, `/metrics` and `/healthz` show it, and nftables drops its next request while HTTP still
# answers. `sipBans.lift` lets it through again; an allowlist entry covering it keeps it from
# being banned; once that entry is gone its next ban takes the second, permanent step; an empty
# step list lifts enforcement; and a From user whose %0D%0A splits the AMI security event into
# frames of the scanner's making bans no address it names and exempts the scanner from none.
# Reads `run.sh`'s own compose, RUNTIME, api_base, METRICS_TOKEN and fail, and api.sh's helpers.
# Self-contained: it connects `netns`, Asterisk's namespace, to `outside` for its own run and
# disconnects it again, lifts the bans it caused and restores the settings it changed, so REUSE
# may select it freely.

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

# Whether Asterisk answers the scanner at all (`uas/register-challenge.xml`), no failed attempt;
# as From user `$1`, `scanner` unless given.
sip_ban_answered() {
  dc exec -T sipp-outside sh -c "sipp -sf /scenarios/uas/register-challenge.xml \
    -key user '${1:-scanner}' -m 1 -timeout 3s -timeout_error -nostdin \
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

# The active ban of `$1` (the scanner unless given) as `<id> <step> <expiresAt>`, nothing while
# it has none.
sip_ban_active() {
  api GET /sipBans | python3 -c '
import json, sys
for ban in json.load(sys.stdin)["items"]:
    if ban["address"] == sys.argv[1]:
        print(ban["id"], ban["step"], ban["expiresAt"])' "${1:-$SIP_BAN_ADDRESS}"
}

sip_ban_has_active() {
  [ -n "$(sip_ban_active)" ]
}

# Fails attempts until the scanner holds an active ban, at most SIP_BAN_ATTEMPTS of them. The ban
# follows the attempt that reached the threshold by milliseconds, and can land after the look for
# it but before the next attempt, which nftables then drops: an attempt unanswered is the ban,
# once it shows.
sip_ban_fail_until_banned() {
  for ((attempt = 1; attempt <= SIP_BAN_ATTEMPTS; attempt++)); do
    if ! sip_ban_attempt; then
      poll $SIP_BAN_POLLS 1 sip_ban_has_active && return 0
      fail "Asterisk did not answer the scanner's attempt $attempt, and no ban holds"
    fi
    sip_ban_has_active && return 0
  done
  fail "$SIP_BAN_ATTEMPTS failed attempts did not ban the scanner"
}

sip_ban_lift() {
  api_delete "/sipBans/$1"
}

# `sip_ban_metric <name>` prints the metric's sample.
sip_ban_metric() {
  curl -fsS "${FWD[@]}" -H "Authorization: Bearer $METRICS_TOKEN" "$api_base/metrics" \
    | awk -v name="$1" '$1 == name { print $2 }'
}

# The drop rules counted at least one packet, as of the ban helper's last heartbeat (§7).
sip_ban_counted() {
  last_read=$(sip_ban_metric zamfono_sip_ban_dropped_packets_total) && [ "${last_read:-0}" -ge 1 ]
}

# The `outside` network's name, for the runtime's `network` command.
sip_ban_network() {
  local id
  id=$(dc ps -q sipp-outside)
  "$RUNTIME" inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}' "$id"
}

# What Asterisk writes to AMI for the security events, read as `core` reads it (its own AMI user,
# from its container) until both injected values have shown or 30 s have passed.
SIP_BAN_AMI_TAP_JS='
const socket = require("node:net").connect(5038, "asterisk");
let seen = "";
const done = () => { socket.destroy(); process.exit(0); };
setTimeout(done, 30000);
socket.write(`Action: Login\r\nUsername: zamfono\r\nSecret: ${process.env.AMI_PASSWORD}\r\nEvents: security\r\n\r\n`);
socket.on("data", chunk => {
  process.stdout.write(chunk);
  seen += chunk.toString("latin1");
  if (seen.includes("RemoteAddress: 203.0.113.200/") && seen.includes("x\r\n\r\nEvent: SuccessfulAuth")) {
    setTimeout(done, 1000);
  }
});'

# Whether file `$1` holds the bytes of `$2` in one piece. Not `grep -F`: it takes each line of a
# multi-line pattern as a pattern of its own, and a bare CR matches every line AMI ends in CR/LF.
sip_ban_tap_carries() {
  python3 -c 'import sys; sys.exit(sys.argv[2].encode("latin1") not in open(sys.argv[1], "rb").read())' \
    "$1" "$2"
}

# The From users the injection sends: decoded, `\r\nRemoteAddress: 203.0.113.200/\r\n\r\n` and
# `x\r\n\r\nEvent: SuccessfulAuth`; a `:` must be escaped, since pjsip reads it as the password.
SIP_BAN_FORGED_ADDRESS=203.0.113.200
SIP_BAN_FORGE_BAN='%0D%0ARemoteAddress%3A%20203.0.113.200/%0D%0A%0D%0A'
SIP_BAN_FORGE_EXEMPT='x%0D%0A%0D%0AEvent%3A%20SuccessfulAuth'

# A From user with CR/LF puts frames of the scanner's making into the AMI stream: they ban no
# address they name and exempt the scanner from nothing, with exemption on. The forging requests
# are unauthenticated REGISTERs, each raising an `InvalidAccountID` and the challenge alone, so
# nothing genuine of them counts: an authenticated retry would add a `ChallengeResponseFailed`.
run_sip_ban_injection() {
  local tap tap_pid attempt id
  api PATCH /settings '{"sipBanSuccessExemptS":3600,"sipBanSteps":[86400,null]}' >/dev/null
  tap=$(mktemp)
  dc exec -T core node -e "$SIP_BAN_AMI_TAP_JS" >"$tap" </dev/null &
  tap_pid=$!
  # The tap's login is answered before any event it is to see.
  poll 10 1 grep -q 'Authentication accepted' "$tap" || fail 'the AMI tap did not log in'
  for ((attempt = 1; attempt <= 2 * SIP_BAN_FAILURES; attempt++)); do
    sip_ban_answered "$SIP_BAN_FORGE_BAN" \
      || fail "Asterisk did not answer the forging request $attempt"
  done
  sip_ban_answered "$SIP_BAN_FORGE_EXEMPT" || fail 'Asterisk did not answer the exempting request'
  wait "$tap_pid" || fail 'the AMI tap failed'
  echo '   the AMI stream carries, per InvalidAccountID, from AccountID on:'
  python3 -c '
import re, sys
text = open(sys.argv[1], encoding="latin1", newline="").read()
pattern = r"Event: InvalidAccountID\r\n.*?(AccountID: .*?RemoteAddress: IPV4[^\r]*\r\n)"
found = re.findall(pattern, text, re.S)
for value in sorted({re.sub(r"SessionID: [^\r]*", "SessionID: …", v) for v in found}):
    print("     " + repr(value))' "$tap"
  sip_ban_tap_carries "$tap" $'AccountID: \r\nRemoteAddress: 203.0.113.200/\r\n\r\n' \
    && sip_ban_tap_carries "$tap" $'AccountID: x\r\n\r\nEvent: SuccessfulAuth\r\n' \
    || fail 'the AMI stream does not carry the From users unescaped'
  rm -f "$tap"
  # A forged SuccessfulAuth would exempt the scanner for an hour: its failures still ban it, and
  # the events before them have been read once they have.
  sip_ban_fail_until_banned
  read -r id _ <<<"$(sip_ban_active)"
  [ -z "$(sip_ban_active "$SIP_BAN_FORGED_ADDRESS")" ] \
    || fail "the forged RemoteAddress $SIP_BAN_FORGED_ADDRESS was banned"
  sip_ban_lift "$id"
  echo '   CR/LF in the From user: no forged address banned, the scanner not exempted'
}

run_sip_ban_step() {
  echo '== §5.6 failed SIP attempts ban their source, nftables drops it =='
  local network netns settings id step expires allow attempt
  network=$(sip_ban_network) || fail "could not find sipp-outside's network"
  # Asterisk's namespace is netns's (§6.1).
  netns=$(dc ps -q netns)
  "$RUNTIME" network connect --ip "$SIP_BAN_TARGET" "$network" "$netns" \
    || fail "could not connect netns to $network"
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
  reads 1 sip_ban_metric zamfono_sip_bans_active || fail "zamfono_sip_bans_active reads '$last_read', not 1"
  reads pass healthz_check sipBan:helper || fail '/healthz reports the ban helper stopped'
  poll $SIP_BAN_POLLS 1 sip_ban_dropped || fail "the banned scanner's REGISTER is still answered"
  sip_ban_http_answered || fail "the banned scanner's HTTP request is not answered"
  echo '   banned at step 1: its SIP is dropped, HTTP answers'

  sip_ban_lift "$id"
  poll $SIP_BAN_POLLS 1 sip_ban_answered || fail 'the lifted scanner is still dropped'
  echo '   sipBans.lift: answered again'
  # The lift's apply wrote a heartbeat, which names what the drop rules counted meanwhile.
  poll $SIP_BAN_POLLS 1 sip_ban_counted \
    || fail "zamfono_sip_ban_dropped_packets_total reads '$last_read' after the dropped REGISTERs"
  echo "   zamfono_sip_ban_dropped_packets_total: $last_read"

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
  run_sip_ban_injection
  api PATCH /settings "$settings" >/dev/null
  sip_ban_answered || fail 'the scanner is dropped once the settings are restored'
  "$RUNTIME" network disconnect "$network" "$netns" \
    || fail "could not disconnect netns from $network"
}
