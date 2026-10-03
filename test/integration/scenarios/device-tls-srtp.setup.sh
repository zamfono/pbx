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

# The issuer of the certificate Asterisk presents (cert-sync.sh's `await_certificate_synced`):
# Caddy's own local CA root, read from its storage on the `proxy` container, copied in for
# baresip to verify the server it dials.
capem=$(mktemp)
baresip_config=$(mktemp)
baresip_accounts=$(mktemp)
trap 'rm -f "$capem" "$baresip_config" "$baresip_accounts"' EXIT
dc exec -T proxy cat /data/caddy/pki/authorities/local/root.crt > "$capem"
# shellcheck disable=SC2086
dc exec -T devices mkdir -p /root/.baresip
# shellcheck disable=SC2086
dc cp "$capem" devices:/root/.baresip/asterisk-ca.pem

cat > "$baresip_config" <<CONFIG
poll_method		epoll
sip_listen		0.0.0.0:$BARESIP_PORT
sip_cafile		/root/.baresip/asterisk-ca.pem
call_local_timeout	120
call_max_calls		4
audio_player		aufile,/dev/null
audio_source		ausine,440
audio_alert		aufile,/dev/null
audio_level		no
ausrc_srate		48000
auplay_srate		48000
ausrc_channels		1
auplay_channels		1
audio_buffer		20-160
rtp_ports		40000-49999
opus_bitrate		28000
opus_complexity		0
opus_stereo		no
opus_sprop_stereo	no
module_path		/usr/lib/baresip/modules
module			opus.so
module			srtp.so
module			ausine.so
module_app		account.so
module_app		menu.so
CONFIG
cat > "$baresip_accounts" <<ACCOUNTS
<sip:$sip_username@$FQDN:5061;transport=tls>;auth_pass=$sip_password;answermode=auto;mediaenc=srtp-mand;regint=600;ptime=20
ACCOUNTS
# shellcheck disable=SC2086
dc cp "$baresip_config" devices:/root/.baresip/config
# shellcheck disable=SC2086
dc cp "$baresip_accounts" devices:/root/.baresip/accounts
# shellcheck disable=SC2086
dc exec -T devices sh -c ': > /root/.baresip/contacts'

# shellcheck disable=SC2086
dc exec -T -d devices sh -c \
  'baresip -f /root/.baresip -s > /root/.baresip/baresip.log 2>&1'

# The contact is reachable once baresip has registered and answered the probe Asterisk sends a
# new contact, which baresip, already up when it registers, always does.
await_contact_status "$sip_username" Avail >/dev/null || {
  echo "the TLS/SRTP device never reached the reachable state" >&2
  exit 1
}
