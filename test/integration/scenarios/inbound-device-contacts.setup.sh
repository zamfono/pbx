#!/usr/bin/env bash
# §9.3 "One endpoint per device", §10.4: a user whose `ringotel` device is registered from two
# phones at once (two baresip devices on one account, as the Ringotel app on desktop and mobile),
# each a contact of the device's AOR. The call to the user's DID must ring both; the second
# answers once both rang (`_answer-when-both-ring.py`), and the first is cancelled.
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

DID=+15551010
EXT=107
RING_DIR=/root/.baresip-ring
ANSWER_DIR=/root/.baresip-answer
CONTROL_PORT=4444

user_id=$(api POST /users \
  "{\"name\":\"CI Two Phones\",\"email\":\"two-phones@ci.test\",\"extension\":\"$EXT\"}" \
  | jsonfield user.id)
device_id=$(api POST "/users/$user_id/devices" '{"kind":"ringotel","label":"ci-two-phones"}' \
  | jsonfield device.id)
credentials=$(api GET "/devices/$device_id/credentials")
sip_username=$(printf '%s' "$credentials" | jsonfield sipUsername)
sip_password=$(printf '%s' "$credentials" | jsonfield sipPassword)
did_id=$(api POST /dids \
  "{\"number\":\"$DID\",\"target\":{\"kind\":\"user\",\"userId\":\"$user_id\"}}" | jsonfield id)
printf '%s %s\n' "$user_id" "$did_id" > "$(state_file device-contacts)"

account="<sip:$sip_username@$FQDN:5061;transport=tls>;auth_pass=$sip_password"
account="$account;answermode=manual;mediaenc=srtp-mand;regint=600;ptime=20"
start_baresip "$RING_DIR" 5091 "$account"
start_baresip "$ANSWER_DIR" 5092 "$account" \
  "$(printf 'module_app\t\tctrl_tcp.so\nctrl_tcp_listen\t\t127.0.0.1:%s' "$CONTROL_PORT")"

# Both contacts are reachable once each baresip has registered and answered the probe Asterisk
# sends a new contact.
both_reachable() {
  [ "$(contact_status "$sip_username" | grep -c '^Avail$')" = 2 ]
}
poll 40 0.5 both_reachable || {
  echo "the device's two contacts never both reached the reachable state:" \
    "$(contact_status "$sip_username" | tr '\n' ' ')" >&2
  exit 1
}

dc cp "$here/_answer-when-both-ring.py" devices:/root/answer-when-both-ring.py
dc exec -T -d devices sh -c "python3 /root/answer-when-both-ring.py \
  $RING_DIR/baresip.log $ANSWER_DIR/baresip.log $CONTROL_PORT > /root/answerer.log 2>&1"
