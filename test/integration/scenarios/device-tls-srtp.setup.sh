#!/usr/bin/env bash
# §3 "SIP over TLS with SRTP for clients", §9.1 transport-tls, §9.3/§10.4: a user with a `manual`
# device on the `tls` transport (what a Ringotel softphone gets), and a real device registered to
# it — baresip, the way test/load/stress already stands its Ringotel stand-ins up
# (gen_baresip.py), here with a single account instead of many: SIP over TLS to `$FQDN:5061` —
# the stack FQDN (compose.test.yaml's second `asterisk` network alias), a real client's own dial
# target, and the one name the certificate §6.4's sync installs actually carries (a
# `local_certs`-issued certificate for `$FQDN`, which bring-up waited to replace the placeholder,
# whose CN is the other alias, `zamfono`) — so baresip verifies the server against Caddy's local
# CA, the way a real client verifies a CA-issued certificate,
# `mediaenc=srtp-mand` (SDES-SRTP, RTP/SAVP) and only the `opus` codec module loaded, so whatever
# Asterisk offers, the device can answer with nothing else — no `settings.codecs_json` change
# needed, and none made, since the shared `ci-trunk` other scenarios still use depends on the
# tenant default including `alaw` (db/migrations: `["opus","g722","alaw"]`). `-s` turns on
# baresip's own SIP trace (to `baresip.log`), the check's evidence of the SDP it actually
# negotiated (its RTP/SAVP crypto line and its chosen codec) once the call has ended and Asterisk's
# own channel for it is gone.
#
# The call goes straight to the device's own DID, not the ring group, so it is independent of
# every other scenario's state.
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

DID=+15551009
EXT=106
BARESIP_PORT=5090

user_id=$(api POST /users \
  "{\"name\":\"CI TLS Device\",\"email\":\"tls-device@ci.test\",\"extension\":\"$EXT\"}" \
  | jsonfield user.id)
api PATCH "/users/$user_id" '{"recordCalls": true}' >/dev/null
device=$(api POST "/users/$user_id/devices" \
  '{"kind":"manual","label":"ci-tls-device","transport":"tls"}')
sip_username=$(printf '%s' "$device" | jsonfield connectionSettings.username)
sip_password=$(printf '%s' "$device" | jsonfield connectionSettings.password)
did_id=$(api POST /dids \
  "{\"number\":\"$DID\",\"target\":{\"kind\":\"user\",\"userId\":\"$user_id\"}}" | jsonfield id)

# The newest call before this scenario's own, the way the other recording scenarios' setups tell
# their call apart (`_recording-check.sh`).
newest_call_id > "$(state_file recording-before)"
printf '%s %s %s %s\n' "$user_id" "$did_id" "$sip_username" "$sip_password" \
  > "$(state_file tls-srtp)"

account="<sip:$sip_username@$FQDN:5061;transport=tls>;auth_pass=$sip_password"
start_baresip /root/.baresip "$BARESIP_PORT" \
  "$account;answermode=auto;mediaenc=srtp-mand;regint=600;ptime=20"

# The contact is reachable once baresip has registered and answered the probe Asterisk sends a
# new contact, which baresip, already up when it registers, always does.
await_contact_status "$sip_username" Avail >/dev/null || {
  echo "the TLS/SRTP device never reached the reachable state" >&2
  exit 1
}
