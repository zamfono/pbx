#!/usr/bin/env bash
# The far end of a transcoded call switching RTP source mid-call, with sequence numbers that step
# back (`inbound-ssrc-switch.xml`). A user whose one device is a real baresip, the way
# `device-tls-srtp.setup.sh` stands one up (SIP over TLS, SDES-SRTP, Opus alone), so Asterisk
# transcodes the trunk's A-law for it; the user's calls at level `qos`, so the call leaves the
# per-leg packet counts the check reads. The two captures the trunk side plays are written into
# the `sipp` container (`_ssrc-switch-pcap.py`).
set -euo pipefail

: "${FQDN:?set by run.sh, exported}"

api_base=$1
token=$2
compose=$3
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"
# shellcheck source=_baresip.sh
. "$here/_baresip.sh"

DID=+15551012
EXT=108
BARESIP_PORT=5094
BARESIP_DIR=/root/.baresip-ssrc

user_id=$(api POST /users \
  "{\"name\":\"CI SSRC Switch\",\"email\":\"ssrc-switch@ci.test\",\"extension\":\"$EXT\"}" \
  | jsonfield user.id)
api PATCH "/users/$user_id" '{"logLevel": "qos"}' >/dev/null
device=$(api POST "/users/$user_id/devices" \
  '{"kind":"manual","label":"ci-ssrc-switch","transport":"tls"}')
sip_username=$(printf '%s' "$device" | jsonfield connectionSettings.username)
sip_password=$(printf '%s' "$device" | jsonfield connectionSettings.password)
did_id=$(api POST /dids \
  "{\"number\":\"$DID\",\"target\":{\"kind\":\"user\",\"userId\":\"$user_id\"}}" | jsonfield id)
printf '%s %s %s\n' "$user_id" "$did_id" "$sip_username" > "$(state_file ssrc-switch)"

dc exec -T sipp sh -c 'mkdir -p /tmp/ssrc-switch && python3 /scenarios/_ssrc-switch-pcap.py /tmp/ssrc-switch'

account="<sip:$sip_username@$FQDN:5061;transport=tls>;auth_pass=$sip_password"
start_baresip "$BARESIP_DIR" "$BARESIP_PORT" \
  "$account;answermode=auto;mediaenc=srtp-mand;regint=600;ptime=20"

await_contact_status "$sip_username" Avail >/dev/null || {
  echo "the SSRC switch device never reached the reachable state" >&2
  exit 1
}
